"""Regression checks for citation scoring; no model or network needed."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name('evaluate-knowledge-answers.py')
spec = importlib.util.spec_from_file_location('knowledge_answers', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CitationScoringTests(unittest.TestCase):
    def setUp(self):
        self.evidence = [{'title': '手册.md', 'source': 'doc/手册.md', 'location': '第 12 行', 'content': '默认目录为 memory-vault。'}]
    def test_matching_file_and_line_support_gold(self):
        values = module.evaluate_citations('位置在这里 [手册.md · 第 12 行]', self.evidence, 'doc/手册.md', 'memory-vault')
        self.assertTrue(values[0]['valid'])
        self.assertTrue(values[0]['referencesGoldEvidence'])
    def test_correct_filename_but_invented_line_is_invalid(self):
        values = module.evaluate_citations('[手册.md · 第 99 行]', self.evidence)
        self.assertFalse(values[0]['valid'])
    def test_an_invented_source_is_invalid(self):
        values = module.evaluate_citations('[不存在.md · 第 12 行]', self.evidence)
        self.assertFalse(values[0]['valid'])
    def test_valid_source_does_not_imply_gold_fact_is_supported(self):
        values = module.evaluate_citations('[手册.md · 第12行]', self.evidence, 'doc/手册.md', '未包含的事实')
        self.assertTrue(values[0]['valid'])
        self.assertFalse(values[0]['referencesGoldEvidence'])
    def test_missing_citation_is_distinct_from_invalid_citation(self):
        self.assertEqual(module.evaluate_citations('我没有找到资料。', self.evidence), [])
    def test_insufficiency_covers_plain_chinese_refusals(self):
        self.assertTrue(module.expresses_insufficiency('信息不在提供的资料中。'))
        self.assertTrue(module.expresses_insufficiency('信息不足，无法直接回答。'))
        self.assertFalse(module.expresses_insufficiency('默认目录是 memory-vault。'))
    def test_remote_model_endpoints_are_rejected_before_reading_inputs(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--input', '/nonexistent', '--output', '/nonexistent', '--endpoint', 'https://example.com/api/chat'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Only a local loopback', result.stderr)

class CitationFormatTests(unittest.TestCase):
    def test_ranges_and_combined_locations_are_explicitly_flagged(self):
        answer = '[手册.md · 第 12-13 行] [手册.md · 第 1 行/第 12 行]'
        self.assertEqual(len(module.citation_format_issues(answer)), 2)

    def test_valid_citations_and_ordinary_brackets_are_not_format_issues(self):
        self.assertEqual(module.citation_format_issues('[手册.md · 第 12 行] [普通文字]'), [])


if __name__ == '__main__':
    unittest.main()
