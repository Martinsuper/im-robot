//! Opt-in retrieval evaluation against real repository documents, isolated from user state.
use super::*;

#[derive(Deserialize)]
struct Fixture {
    scope: String,
    documents: Vec<String>,
    cases: Vec<Case>,
    #[serde(rename = "negativeQueries")]
    negatives: Vec<String>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    query: String,
    source: String,
    evidence: String,
}
fn evidence_rank(hits: &[RetrievalHit], expected_path: &str, evidence: &str) -> Option<usize> {
    hits.iter()
        .position(|h| h.source == expected_path && h.content.contains(evidence))
        .map(|i| i + 1)
}
fn citation_matches_source(hit: &RetrievalHit) -> bool {
    let Ok(source) = std::fs::read_to_string(&hit.source) else {
        return false;
    };
    let Some(position) = source.find(&hit.content) else {
        return false;
    };
    let line = source[..position].chars().filter(|&c| c == '\n').count() + 1;
    hit.locator == format!("第 {line} 行")
}
fn persist_vectors(db: &MemoryDb, all: &[Entry], vectors: Vec<Vec<f32>>, signature: &str) {
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().unwrap();
    for (entry, vector) in all.iter().zip(vectors) {
        tx.execute(
            "INSERT INTO retrieval_vectors VALUES(?1,?2,?3,?4)",
            params![
                entry.hit.id,
                entry.fingerprint,
                signature,
                serde_json::to_string(&vector).unwrap()
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}
#[tokio::test]
#[ignore = "requires a real local embedding service; reads repository docs only"]
async fn repository_documents_retrieval_and_isolation() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let fixture: Fixture = serde_json::from_str(
        &std::fs::read_to_string(root.join("tests/fixtures/knowledge-retrieval-project.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.cases.len(), 30);
    let config = RetrievalSettings {
        enabled: true,
        endpoint: std::env::var("PIKO_EMBEDDING_TEST_ENDPOINT").expect("set local endpoint"),
        model: std::env::var("PIKO_EMBEDDING_TEST_MODEL").unwrap_or_else(|_| "bge-m3".into()),
        allow_remote: false,
        revision: 1,
    };
    config.validate().unwrap();
    let signature = config.signature();
    let temporary = tempfile::tempdir().unwrap();
    let db = crate::memory::open_in_memory_db().unwrap();
    let mut original_to_copy = HashMap::new();
    let mut source_labels = HashMap::new();
    for relative in &fixture.documents {
        let source = root.join(relative);
        let copy = temporary.path().join("piko").join(relative);
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::copy(&source, &copy).unwrap();
        let copy = copy.canonicalize().unwrap();
        assert!(import_file(&db, &copy, &fixture.scope).unwrap());
        original_to_copy.insert(relative.clone(), copy.to_string_lossy().into_owned());
        source_labels.insert(copy.to_string_lossy().into_owned(), relative.clone());
    }
    // Deliberately contradictory other-project material, not a claim about the real project.
    let foreign = temporary.path().join("other-project");
    std::fs::create_dir_all(&foreign).unwrap();
    let foreign_file = foreign.join("12-markdown-memory-vault.md");
    std::fs::write(&foreign_file,"# 另一个项目的规则（合成干扰资料）\n\nMarkdown 记忆默认目录是 /other-project/vault。文件每 3 秒同步一次。删除 Markdown 文件时立即忘记。向量模型叫 other-embedding。\n").unwrap();
    let foreign_file = foreign_file.canonicalize().unwrap();
    import_file(&db, &foreign_file, "other-project").unwrap();
    source_labels.insert(
        foreign_file.to_string_lossy().into_owned(),
        "[synthetic] other-project/12-markdown-memory-vault.md".into(),
    );
    let general = temporary.path().join("通用资料.md");
    std::fs::write(&general,"# 通用回答准则\n\n所有项目共用的原则：引用资料来源，证据不足时明确说明没有找到答案，不猜测密码或财务信息。\n").unwrap();
    let general = general.canonicalize().unwrap();
    import_file(&db, &general, "").unwrap();
    source_labels.insert(
        general.to_string_lossy().into_owned(),
        "[synthetic] 通用资料.md".into(),
    );
    let unindexed = entries(&db, &signature, None).unwrap();
    let chunk_count = unindexed.len();
    for batch in unindexed.chunks(8) {
        let inputs: Vec<_> = batch
            .iter()
            .map(|e| format!("{}\n{}", e.hit.title, e.hit.content))
            .collect();
        persist_vectors(
            &db,
            batch,
            embed_request(&config, &inputs, None).await.unwrap(),
            &signature,
        );
    }
    // Fresh SQLite connection proves both the source index and embeddings survive reopening.
    let database_file = temporary.path().join("evaluation.db");
    db.0.lock()
        .unwrap()
        .backup("main", &database_file, None)
        .unwrap();
    drop(db);
    let db = MemoryDb(crate::data_gate::DataMutex::new(
        Connection::open(&database_file).unwrap(),
    ));
    let scoped = entries(&db, &signature, Some(&fixture.scope)).unwrap();
    assert!(scoped.iter().all(|e| e.vector.is_some()));
    let mut query_vectors = Vec::new();
    for batch in fixture.cases.chunks(8) {
        query_vectors.extend(
            embed_request(
                &config,
                &batch.iter().map(|c| c.query.clone()).collect::<Vec<_>>(),
                None,
            )
            .await
            .unwrap(),
        );
    }
    let mut results = Vec::new();
    let mut qa_inputs = Vec::new();
    let mut lexical_top1 = 0;
    let mut lexical_top8 = 0;
    let mut hybrid_top1 = 0;
    let mut hybrid_top5 = 0;
    let mut hybrid_top8 = 0;
    let mut checked_citations = 0;
    let mut bad_citations = 0;
    let mut scoped_leaks = 0;
    for (case, vector) in fixture.cases.iter().zip(&query_vectors) {
        let copy = &original_to_copy[&case.source];
        assert!(
            std::fs::read_to_string(copy)
                .unwrap()
                .contains(&case.evidence),
            "gold evidence missing: {}",
            case.id
        );
        let fts = fts_hits(&db, &case.query).unwrap();
        let lexical = rank(&scoped, &case.query, None, &fts, 8);
        let hybrid = rank(&scoped, &case.query, Some(vector), &fts, 8);
        let lr = evidence_rank(&lexical, copy, &case.evidence);
        let hr = evidence_rank(&hybrid, copy, &case.evidence);
        let expanded = expand_neighbors(&db, hybrid.clone(), Some(&fixture.scope)).unwrap();
        let expanded_rank = evidence_rank(&expanded, copy, &case.evidence);
        assert!(expanded.iter().all(citation_matches_source));
        assert!(expanded
            .iter()
            .all(|hit| hit.scope.is_empty() || hit.scope == fixture.scope));
        qa_inputs.push(serde_json::json!({"id":case.id,"query":case.query,"hasAnswer":true,"expectedSource":case.source,"expectedEvidence":case.evidence,"evidence":expanded.iter().map(|h|serde_json::json!({"title":h.title,"source":source_labels.get(&h.source),"location":h.locator,"scope":h.scope,"content":h.content})).collect::<Vec<_>>()}));
        lexical_top1 += usize::from(lr == Some(1));
        lexical_top8 += usize::from(lr.is_some());
        hybrid_top1 += usize::from(hr == Some(1));
        hybrid_top5 += usize::from(hr.is_some_and(|r| r <= 5));
        hybrid_top8 += usize::from(hr.is_some());
        for hit in &hybrid {
            checked_citations += 1;
            bad_citations += usize::from(!citation_matches_source(hit));
            scoped_leaks += usize::from(!hit.scope.is_empty() && hit.scope != fixture.scope);
        }
        results.push(serde_json::json!({"id":case.id,"query":case.query,"expectedSource":case.source,"expectedEvidence":case.evidence,"lexicalEvidenceRank":lr,"hybridEvidenceRank":hr,"expandedEvidenceRank":expanded_rank,"topResults":hybrid.iter().map(|h|serde_json::json!({"source":source_labels.get(&h.source),"location":h.locator,"scope":h.scope,"score":h.score,"containsExpectedEvidence":h.content.contains(&case.evidence)})).collect::<Vec<_>>()}));
    }
    let mut negatives = Vec::new();
    for query in &fixture.negatives {
        let vector = embed_request(&config, std::slice::from_ref(query), None)
            .await
            .unwrap()
            .remove(0);
        let hits = rank(
            &scoped,
            query,
            Some(&vector),
            &fts_hits(&db, query).unwrap(),
            8,
        );
        qa_inputs.push(serde_json::json!({"id":format!("N{}",negatives.len()+1),"query":query,"hasAnswer":false,"evidence":hits.iter().map(|h|serde_json::json!({"title":h.title,"source":source_labels.get(&h.source),"location":h.locator,"scope":h.scope,"content":h.content})).collect::<Vec<_>>()}));
        negatives.push(serde_json::json!({"query":query,"returnedEvidenceCount":hits.len(),"topSource":hits.first().and_then(|h|source_labels.get(&h.source)),"note":"No answer exists in corpus. Returning candidates does not itself prove the generation model will hallucinate."}));
    }
    let unknown = entries(&db, &signature, Some("unknown-project")).unwrap();
    assert!(unknown.iter().all(|e| e.hit.scope.is_empty()));
    let all = entries(&db, &signature, None).unwrap();
    let global = rank(
        &all,
        "Markdown 记忆文件默认保存在哪里？",
        Some(&query_vectors[0]),
        &fts_hits(&db, "Markdown 记忆文件默认保存在哪里？").unwrap(),
        8,
    );
    let foreign_global = global.iter().filter(|h| h.scope == "other-project").count();
    // Update and delete a temporary copy. Original repository files remain untouched.
    let changed_path = PathBuf::from(&original_to_copy[&fixture.documents[0]]);
    let changed_id = format!("doc-{}", hash(&changed_path.to_string_lossy()));
    std::fs::write(
        &changed_path,
        "# 更新验收\n\nEVAL_REPLACEMENT_20261021 是本次更新后的唯一内容。\n",
    )
    .unwrap();
    assert!(import_file(&db, &changed_path, &fixture.scope).unwrap());
    let refreshed = entries(&db, &signature, Some(&fixture.scope)).unwrap();
    let changed: Vec<_> = refreshed
        .iter()
        .filter(|e| e.hit.id.starts_with(&format!("{changed_id}:")))
        .collect();
    assert_eq!(changed.len(), 1);
    assert!(changed[0].vector.is_none());
    assert!(changed[0].hit.content.contains("EVAL_REPLACEMENT_20261021"));
    {
        let mut conn = db.0.lock().unwrap();
        let tx = conn.transaction().unwrap();
        remove_chunks(&tx, &changed_id).unwrap();
        tx.execute("DELETE FROM knowledge_documents WHERE id=?1", [&changed_id])
            .unwrap();
        tx.commit().unwrap();
    }
    assert!(entries(&db, &signature, None)
        .unwrap()
        .iter()
        .all(|e| !e.hit.id.starts_with(&format!("{changed_id}:"))));
    assert!(fts_hits(&db, "EVAL_REPLACEMENT_20261021")
        .unwrap()
        .is_empty());
    let report = serde_json::json!({"model":config.model,"corpus":"5 real repository documents plus 2 explicitly synthetic isolation probes","documents":fixture.documents,"indexedChunks":chunk_count,"questions":fixture.cases.len(),"metrics":{"lexicalTop1":lexical_top1,"lexicalTop8":lexical_top8,"hybridTop1":hybrid_top1,"hybridTop5":hybrid_top5,"hybridTop8":hybrid_top8,"expandedCheckedCitations":qa_inputs.iter().filter(|case| case["hasAnswer"] == true).map(|case| case["evidence"].as_array().unwrap().len()).sum::<usize>(),"expandedEvidenceRecall":results.iter().filter(|case| !case["expandedEvidenceRank"].is_null()).count(),"checkedCitations":checked_citations,"invalidCitations":bad_citations,"scopedForeignHits":scoped_leaks},"lifecycle":{"sqliteReopen":true,"updateInvalidatesOldVectors":true,"deleteRemovesChunksAndFts":true,"unknownProjectOnlyGetsGeneralSources":true},"unscopedChatRisk":{"foreignHitsInTop8":foreign_global,"note":"Unbound conversations search all projects; explicit scoped retrieval is tested separately."},"negativeQueries":negatives,"cases":results,"generationEvaluation":"Not performed: retrieval citations are checked against source text and line numbers; this does not validate generated answers or model-authored citations.","acceptance":{"minimumEvidenceRecallAt8":0.9,"passed":hybrid_top8>=27 && bad_citations==0 && scoped_leaks==0}});
    let output = std::env::var("PIKO_PROJECT_EVALUATION_REPORT").expect("set report output path");
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    std::fs::write(
        format!("{output}.qa-input.json"),
        serde_json::to_vec_pretty(&qa_inputs).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(&report["metrics"]).unwrap()
    );
    println!("unscoped foreign hits: {foreign_global}; detailed report: {output}");
    assert_eq!(bad_citations, 0, "source text/line citation mismatch");
    assert_eq!(scoped_leaks, 0, "explicit project scope leaked");
    assert!(
        results
            .iter()
            .all(|case| !case["expandedEvidenceRank"].is_null()),
        "expanded context missed fixed project evidence"
    );
    assert!(
        hybrid_top8 >= 27,
        "evidence recall@8 below 90%; inspect report for failed questions"
    );
}
