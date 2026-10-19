//! Generate wire contracts from the Rust AST. Unsupported wire types fail generation.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};
use syn::{Fields, GenericArgument, Item, PathArguments, Type, UseTree};
#[derive(Clone)]
struct Definition {
    module: String,
    item: Item,
}
#[derive(Default)]
struct Generator {
    definitions: HashMap<String, Definition>,
    imports: HashMap<String, HashMap<String, String>>,
    functions: HashMap<String, (String, syn::ItemFn)>,
    emitted: BTreeMap<String, String>,
    visiting: HashSet<String>,
}
fn attr(attrs: &[syn::Attribute], key: &str) -> Option<String> {
    let mut result = None;
    for a in attrs.iter().filter(|a| a.path().is_ident("serde")) {
        let _ = a.parse_nested_meta(|m| {
            if m.path.is_ident(key) {
                if m.input.peek(syn::Token![=]) {
                    result = Some(m.value()?.parse::<syn::LitStr>()?.value());
                } else {
                    result = Some(String::new());
                }
            } else if m.input.peek(syn::Token![=]) {
                let _: syn::Expr = m.value()?.parse()?;
            }
            Ok(())
        });
    }
    result
}
fn rename(name: &str, rule: Option<&str>) -> String {
    let words: Vec<String> = if name.contains('_') {
        name.split('_').map(str::to_owned).collect()
    } else {
        let mut words = Vec::new();
        let mut current = String::new();
        for c in name.chars() {
            if c.is_uppercase() && !current.is_empty() {
                words.push(current);
                current = String::new();
            }
            current.push(c.to_ascii_lowercase());
        }
        if !current.is_empty() {
            words.push(current);
        }
        words
    };
    match rule {
        Some("camelCase") => words
            .iter()
            .enumerate()
            .map(|(i, s)| {
                if i == 0 {
                    s.clone()
                } else {
                    let mut c = s.chars();
                    c.next().unwrap().to_uppercase().collect::<String>() + c.as_str()
                }
            })
            .collect(),
        Some("snake_case") => words.join("_"),
        Some("kebab-case") => words.join("-"),
        Some("SCREAMING_SNAKE_CASE") => words.join("_").to_uppercase(),
        Some("lowercase") => name.to_lowercase(),
        Some("UPPERCASE") => name.to_uppercase(),
        _ => name.into(),
    }
}
fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn imports(tree: &UseTree, prefix: String, out: &mut HashMap<String, String>) {
    match tree {
        UseTree::Path(p) => imports(&p.tree, format!("{prefix}{}::", p.ident), out),
        UseTree::Name(n) => {
            out.insert(n.ident.to_string(), format!("{prefix}{}", n.ident));
        }
        UseTree::Rename(n) => {
            out.insert(n.rename.to_string(), format!("{prefix}{}", n.ident));
        }
        UseTree::Group(g) => {
            for t in &g.items {
                imports(t, prefix.clone(), out)
            }
        }
        UseTree::Glob(_) => {}
    }
}
impl Generator {
    fn read(&mut self, path: &Path, module: &str) {
        let file = syn::parse_file(&std::fs::read_to_string(path).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let directory = if matches!(
            path.file_name().unwrap().to_str().unwrap(),
            "lib.rs" | "mod.rs"
        ) {
            path.parent().unwrap().to_owned()
        } else {
            path.with_extension("")
        };
        self.items(file.items, path.parent().unwrap(), &directory, module);
    }
    fn items(&mut self, items: Vec<Item>, parent: &Path, directory: &Path, module: &str) {
        for item in items {
            let attrs = match &item {
                Item::Mod(x) => &x.attrs,
                Item::Fn(x) => &x.attrs,
                _ => &vec![],
            };
            if attrs
                .iter()
                .any(|a| a.path().is_ident("cfg") && format!("{:?}", a.meta).contains("test"))
            {
                continue;
            }
            match &item {
                Item::Use(u) => imports(
                    &u.tree,
                    String::new(),
                    self.imports.entry(module.into()).or_default(),
                ),
                Item::Struct(s) => {
                    self.definitions.insert(
                        format!("{module}::{}", s.ident),
                        Definition {
                            module: module.into(),
                            item: item.clone(),
                        },
                    );
                }
                Item::Enum(e) => {
                    self.definitions.insert(
                        format!("{module}::{}", e.ident),
                        Definition {
                            module: module.into(),
                            item: item.clone(),
                        },
                    );
                }
                Item::Type(t) => {
                    self.definitions.insert(
                        format!("{module}::{}", t.ident),
                        Definition {
                            module: module.into(),
                            item: item.clone(),
                        },
                    );
                }
                Item::Fn(f)
                    if f.attrs.iter().any(|a| {
                        a.path()
                            .segments
                            .last()
                            .is_some_and(|s| s.ident == "command")
                    }) =>
                {
                    self.functions.insert(
                        format!("{module}::{}", f.sig.ident),
                        (module.into(), f.clone()),
                    );
                }
                Item::Mod(m) => {
                    let child = if module.is_empty() {
                        m.ident.to_string()
                    } else {
                        format!("{module}::{}", m.ident)
                    };
                    if let Some((_, items)) = &m.content {
                        self.items(
                            items.clone(),
                            parent,
                            &directory.join(m.ident.to_string()),
                            &child,
                        );
                    } else {
                        let explicit = m.attrs.iter().find_map(|a| {
                            if a.path().is_ident("path") {
                                if let syn::Meta::NameValue(v) = &a.meta {
                                    if let syn::Expr::Lit(l) = &v.value {
                                        if let syn::Lit::Str(s) = &l.lit {
                                            return Some(parent.join(s.value()));
                                        }
                                    }
                                }
                                None
                            } else {
                                None
                            }
                        });
                        let first = directory.join(format!("{}.rs", m.ident));
                        let path = explicit.unwrap_or_else(|| {
                            if first.exists() {
                                first
                            } else {
                                directory.join(m.ident.to_string()).join("mod.rs")
                            }
                        });
                        if path.exists() {
                            self.read(&path, &child);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    fn resolve(&self, module: &str, path: &syn::Path) -> String {
        let parts: Vec<_> = path.segments.iter().map(|p| p.ident.to_string()).collect();
        let first = &parts[0];
        let text = parts.join("::");
        let local = format!("{module}::{text}");
        if self.definitions.contains_key(&local) {
            return local;
        }
        let resolved = if first == "crate" {
            parts[1..].join("::")
        } else if first == "super" || first == "self" {
            let mut base: Vec<_> = module
                .split("::")
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            let mut i = 0;
            while i < parts.len() && (parts[i] == "super" || parts[i] == "self") {
                if parts[i] == "super" {
                    base.pop();
                }
                i += 1;
            }
            base.extend(parts[i..].iter().cloned());
            base.join("::")
        } else if let Some(target) = self.imports.get(module).and_then(|i| i.get(first)) {
            format!(
                "{}{}",
                target,
                if parts.len() > 1 {
                    format!("::{}", parts[1..].join("::"))
                } else {
                    String::new()
                }
            )
        } else {
            text.clone()
        };
        let resolved = resolved.trim_start_matches("crate::").to_owned();
        if self.definitions.contains_key(&resolved) {
            return resolved;
        }
        // Follow reexports (e.g. memory::CreateMemoryInput).
        if let Some((owner, name)) = resolved.rsplit_once("::") {
            if let Some(import) = self.imports.get(owner).and_then(|i| i.get(name)) {
                let parsed: syn::Path = syn::parse_str(import).unwrap();
                return self.resolve(owner, &parsed);
            }
        }
        let name = parts.last().unwrap();
        let candidates: Vec<_> = self
            .definitions
            .keys()
            .filter(|k| k.rsplit("::").next() == Some(name.as_str()))
            .collect();
        if candidates.len() == 1 {
            return candidates[0].clone();
        }
        panic!("Unresolved/ambiguous wire type {text} in {module}: {candidates:?}");
    }
    fn ty(&mut self, module: &str, ty: &Type, input: bool) -> String {
        match ty {
            Type::Reference(r) => self.ty(module, &r.elem, input),
            Type::Slice(s) => format!("Array<{}>", self.ty(module, &s.elem, input)),
            Type::Array(a) => format!("Array<{}>", self.ty(module, &a.elem, input)),
            Type::Tuple(t) => {
                if t.elems.is_empty() {
                    "null".into()
                } else {
                    format!(
                        "[{}]",
                        t.elems
                            .iter()
                            .map(|x| self.ty(module, x, input))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }
            }
            Type::Path(t) => {
                let p = t.path.segments.last().unwrap();
                let name = p.ident.to_string();
                let generics = match &p.arguments {
                    PathArguments::AngleBracketed(a) => a
                        .args
                        .iter()
                        .filter_map(|g| {
                            if let GenericArgument::Type(t) = g {
                                Some(t)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>(),
                    _ => vec![],
                };
                match name.as_str() {
                    "String" | "str" | "PathBuf" => "string".into(),
                    "bool" => "boolean".into(),
                    "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64"
                    | "isize" | "f32" | "f64" => "number".into(),
                    "Value" => "JsonValue".into(),
                    "Option" => format!("{} | null", self.ty(module, generics[0], input)),
                    "Result" | "Box" | "Arc" => self.ty(module, generics[0], input),
                    "Vec" | "HashSet" | "BTreeSet" | "VecDeque" => {
                        format!("Array<{}>", self.ty(module, generics[0], input))
                    }
                    "HashMap" | "BTreeMap" | "Map" => {
                        format!("Record<string, {}>", self.ty(module, generics[1], input))
                    }
                    _ => {
                        let id = self.resolve(module, &t.path);
                        self.definition(&id, input)
                    }
                }
            }
            _ => panic!("Unsupported wire type {ty:?} in {module}"),
        }
    }
    fn fields(&mut self, module: &str, fields: &Fields, rule: Option<&str>, input: bool) -> String {
        match fields {
            Fields::Unit => "null".into(),
            Fields::Unnamed(f) => {
                if f.unnamed.len() == 1 {
                    self.ty(module, &f.unnamed[0].ty, input)
                } else {
                    format!(
                        "[{}]",
                        f.unnamed
                            .iter()
                            .map(|f| self.ty(module, &f.ty, input))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }
            }
            Fields::Named(f) => {
                let mut fields = Vec::new();
                let mut flattened = Vec::new();
                for f in &f.named {
                    if attr(&f.attrs, "skip").is_some()
                        || attr(
                            &f.attrs,
                            if input {
                                "skip_deserializing"
                            } else {
                                "skip_serializing"
                            },
                        )
                        .is_some()
                    {
                        continue;
                    }
                    let ty = self.ty(module, &f.ty, input);
                    if attr(&f.attrs, "flatten").is_some() {
                        flattened.push(ty);
                        continue;
                    }
                    let name = attr(&f.attrs, "rename")
                        .unwrap_or_else(|| rename(&f.ident.as_ref().unwrap().to_string(), rule));
                    let optional = if input {
                        attr(&f.attrs, "default").is_some()
                            || matches!(&f.ty,Type::Path(t) if t.path.segments.last().unwrap().ident=="Option")
                    } else {
                        attr(&f.attrs, "skip_serializing_if").is_some()
                    };
                    fields.push(format!(
                        "{}{}: {ty}",
                        q(&name),
                        if optional { "?" } else { "" }
                    ));
                }
                let mut object = format!("{{ {} }}", fields.join("; "));
                for ty in flattened {
                    object = format!("{object} & ({ty})");
                }
                object
            }
        }
    }
    fn definition(&mut self, id: &str, input: bool) -> String {
        let name = format!(
            "T_{}_{}",
            id.trim_start_matches("::").replace("::", "_"),
            if input { "Input" } else { "Output" }
        );
        if self.emitted.contains_key(&name) || !self.visiting.insert(name.clone()) {
            return name;
        }
        let def = self.definitions.get(id).unwrap().clone();
        let rendered = match def.item {
            Item::Struct(s) => self.fields(
                &def.module,
                &s.fields,
                attr(&s.attrs, "rename_all").as_deref(),
                input,
            ),
            Item::Type(t) => self.ty(&def.module, &t.ty, input),
            Item::Enum(e) => {
                let rule = attr(&e.attrs, "rename_all");
                let field_rule = attr(&e.attrs, "rename_all_fields");
                let tag = attr(&e.attrs, "tag");
                let content = attr(&e.attrs, "content");
                let untagged = attr(&e.attrs, "untagged").is_some();
                e.variants
                    .iter()
                    .filter(|v| attr(&v.attrs, "skip").is_none())
                    .map(|v| {
                        let name = attr(&v.attrs, "rename")
                            .unwrap_or_else(|| rename(&v.ident.to_string(), rule.as_deref()));
                        let value =
                            self.fields(&def.module, &v.fields, field_rule.as_deref(), input);
                        if untagged {
                            return value;
                        }
                        match (&v.fields, &tag, &content) {
                            (Fields::Unit, None, _) => q(&name),
                            (Fields::Unit, Some(tag), _) => {
                                format!("{{ {}: {} }}", q(tag), q(&name))
                            }
                            (_, Some(tag), Some(content)) => {
                                format!("{{ {}: {}; {}: {} }}", q(tag), q(&name), q(content), value)
                            }
                            (_, Some(tag), None) => {
                                format!("{{ {}: {} }} & ({value})", q(tag), q(&name))
                            }
                            _ => format!("{{ {}: {} }}", q(&name), value),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" | ")
            }
            _ => unreachable!(),
        };
        self.emitted
            .insert(name.clone(), format!("export type {name} = {rendered};"));
        name
    }
}
fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    let check = std::env::args().any(|a| a == "--check");
    let mut generator = Generator::default();
    generator.read(&root.join("src-tauri/src/lib.rs"), "");
    let bootstrap = std::fs::read_to_string(root.join("src-tauri/src/bootstrap.rs")).unwrap();
    let marker = ".invoke_handler(tauri::generate_handler![";
    let registry = bootstrap
        .split_once(marker)
        .expect("IPC registry")
        .1
        .split_once("])")
        .unwrap()
        .0;
    let commands: Vec<_> = registry
        .lines()
        .map(|l| l.split("//").next().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let mut rows = BTreeMap::new();
    for id in commands {
        let id = id.trim_start_matches("crate::");
        let (module, function) = generator
            .functions
            .get(id)
            .or_else(|| {
                let name = id.rsplit("::").next().unwrap();
                let found: Vec<_> = generator
                    .functions
                    .iter()
                    .filter(|(key, _)| key.rsplit("::").next() == Some(name))
                    .collect();
                if found.len() == 1 {
                    Some(found[0].1)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| panic!("Unregistered definition {id}"))
            .clone();
        let mut args = Vec::new();
        for argument in &function.sig.inputs {
            if let syn::FnArg::Typed(a) = argument {
                let injected = matches!(&*a.ty,Type::Path(t) if matches!(t.path.segments.last().unwrap().ident.to_string().as_str(),"AppHandle"|"State"|"Window"|"WebviewWindow"|"Webview"));
                if injected {
                    continue;
                }
                let syn::Pat::Ident(name) = &*a.pat else {
                    panic!("Unsupported command argument")
                };
                let ty = generator.ty(&module, &a.ty, true);
                let optional = matches!(&*a.ty,Type::Path(t) if t.path.segments.last().unwrap().ident=="Option");
                args.push(format!(
                    "{}{}: {ty}",
                    q(&rename(&name.ident.to_string(), Some("camelCase"))),
                    if optional { "?" } else { "" }
                ));
            }
        }
        let result = match &function.sig.output {
            syn::ReturnType::Default => "null".into(),
            syn::ReturnType::Type(_, ty) => generator.ty(&module, ty, false),
        };
        let name = function.sig.ident.to_string();
        assert!(rows
            .insert(name, (format!("{{ {} }}", args.join("; ")), result))
            .is_none());
    }
    let mut output=String::from("// Generated from Rust by tools/contracts; do not edit.\nimport { invoke } from '@tauri-apps/api/core';\nexport type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n");
    for line in generator.emitted.values() {
        output += line;
        output.push('\n');
    }
    output += "export interface CommandMap {\n";
    for (name, (args, result)) in &rows {
        output += &format!("  {}: {{ args: {}; result: {} }};\n", q(name), args, result);
    }
    output+="}\nexport type CommandName = keyof CommandMap;\nexport class IpcFailure extends Error { constructor(public command: string, public code: string, message: string) { super(message); this.name = 'IpcFailure'; } }\nexport function invokeCommand<K extends CommandName>(command: K, args: CommandMap[K]['args']): Promise<CommandMap[K]['result']> { return invoke<CommandMap[K]['result']>(command, args).catch((error: unknown) => { if (error && typeof error === 'object' && 'code' in error && 'message' in error) throw new IpcFailure(command, String(error.code), String(error.message)); throw new IpcFailure(command, 'backend_error', error instanceof Error ? error.message : String(error)); }); }\n";
    output += "export const commandNames = [";
    for name in rows.keys() {
        output += &format!("{},", q(name));
    }
    output += "] as const;\n";
    output+="/** Compatibility adapter: explicit T describes an existing UI view model. New code uses invokeCommand. */\nexport interface CommandInvoker {\n";
    for (name, (args, result)) in &rows {
        let optional = !args.split(';').any(|f| {
            f.split_once(':')
                .is_some_and(|(key, _)| !key.trim().ends_with('?'))
        });
        output += &format!(
            "  <T = {result}>(command: {}, args{}: {args}, fallback?: T): Promise<T>;\n",
            q(name),
            if optional { "?" } else { "" }
        );
    }
    output+="  <K extends CommandName>(command: K, ...args: {} extends CommandMap[K]['args'] ? [args?: CommandMap[K]['args'], fallback?: CommandMap[K]['result']] : [args: CommandMap[K]['args'], fallback?: CommandMap[K]['result']]): Promise<CommandMap[K]['result']>;\n}\n";
    let protocol = syn::parse_file(
        &std::fs::read_to_string(root.join("src-tauri/src/agent_protocol.rs")).unwrap(),
    )
    .unwrap();
    let mut version = None;
    let mut fields = None;
    for item in protocol.items {
        if let Item::Const(item) = item {
            if item.ident == "VERSION" {
                if let syn::Expr::Lit(lit) = *item.expr {
                    if let syn::Lit::Int(value) = lit.lit {
                        version = Some(value.base10_parse::<u64>().unwrap());
                    }
                }
            } else if item.ident == "EVENT_FIELDS" {
                if let syn::Expr::Reference(reference) = *item.expr {
                    if let syn::Expr::Array(array) = *reference.expr {
                        let mut entries = BTreeMap::new();
                        for entry in array.elems {
                            let syn::Expr::Tuple(tuple) = entry else {
                                panic!("Invalid event schema")
                            };
                            let syn::Expr::Lit(kind) = &tuple.elems[0] else {
                                panic!("Invalid event name")
                            };
                            let syn::Lit::Str(kind) = &kind.lit else {
                                panic!("Invalid event name")
                            };
                            let syn::Expr::Reference(reference) = &tuple.elems[1] else {
                                panic!("Invalid event fields")
                            };
                            let syn::Expr::Array(array) = &*reference.expr else {
                                panic!("Invalid event fields")
                            };
                            let required: Vec<_> = array
                                .elems
                                .iter()
                                .map(|e| {
                                    let syn::Expr::Lit(lit) = e else {
                                        panic!("Invalid event field")
                                    };
                                    let syn::Lit::Str(value) = &lit.lit else {
                                        panic!("Invalid event field")
                                    };
                                    value.value()
                                })
                                .collect();
                            entries.insert(kind.value(), required);
                        }
                        fields = Some(entries);
                    }
                }
            }
        }
    }
    let wire=format!("// Generated from Rust agent_protocol.rs; do not edit.\nexport const PROTOCOL_VERSION = {};\nexport const EVENT_FIELDS = {};\n",version.unwrap(),serde_json::to_string_pretty(&fields.unwrap()).unwrap());
    let wire_path = root.join("agent/wire-schema.mjs");
    if check {
        assert_eq!(
            std::fs::read_to_string(wire_path).unwrap(),
            wire,
            "Agent protocol drifted"
        );
    } else {
        std::fs::write(wire_path, wire).unwrap();
    }
    let destination = root.join("src/generated/ipc.ts");
    if check {
        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            output,
            "IPC bindings drifted: run npm run contracts:generate"
        );
    } else {
        std::fs::write(destination, output).unwrap();
    }
    println!(
        "Rust IPC contracts: {} commands, {} wire types",
        rows.len(),
        generator.emitted.len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn field_names_defaults_and_tagged_enums_follow_serde() {
        let mut generator = Generator::default();
        let item: Item = syn::parse_quote!(
            #[serde(rename_all = "camelCase")]
            struct Input {
                #[serde(default)]
                max_count: u64,
                value: Option<String>,
            }
        );
        generator.definitions.insert(
            "::Input".into(),
            Definition {
                module: String::new(),
                item,
            },
        );
        let ty = generator.definition("::Input", true);
        let emitted = &generator.emitted[&ty];
        assert!(emitted.contains("\"maxCount\"?: number"));
        assert!(emitted.contains("\"value\"?: string | null"));
        let item: Item = syn::parse_quote!(
            #[serde(
                tag = "type",
                rename_all = "kebab-case",
                rename_all_fields = "camelCase"
            )]
            enum Event {
                ToolStart { request_id: String },
            }
        );
        generator.definitions.insert(
            "::Event".into(),
            Definition {
                module: String::new(),
                item,
            },
        );
        let ty = generator.definition("::Event", false);
        assert!(generator.emitted[&ty].contains("tool-start"));
        assert!(generator.emitted[&ty].contains("requestId"));
    }
}
