//! SpecBackend — the estate indexer.
//!
//! Enumerates repos under `$SPEC_SOURCE_ROOT` and, per repo, walks the source tree
//! once to collect `.lean` specs, their `lean_test`/`lean_emit` targets, and (for a
//! repo carrying an `Emits/Contracts.lean` catalog) its contract rows with live
//! `cited` status. The heavy scan is memoized behind a short TTL so a full-estate
//! walk stays off the request hot path.
//!
//! Reused wholesale from botnoc's own tooling so this is a faithful mirror, not a
//! re-implementation: the `sorry` sweep is the authoritative green-check named in
//! botnoc `lean/BUILD.bazel`, and `scan_citations` is the `Discharges:` walk from
//! botnoc `tests/contracts_cited/src/main.rs`.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::proto::{Citation, Contract, ModuleStatus, Spec, SpecLang, SpecStatus};

/// Cap on a returned source blob (GetSpec/GetContract), so a pathological file
/// can't blow up a response.
const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// The fully-computed estate index. Requests filter from this.
#[derive(Default)]
pub struct Index {
    pub specs: Vec<Spec>,
    pub modules: Vec<ModuleStatus>,
    pub contracts: Vec<Contract>,
    /// Repos that could not be scanned (partial-result signal).
    pub unreachable: Vec<String>,
}

struct Cached {
    built: Instant,
    index: Arc<Index>,
}

pub struct SpecBackend {
    source_root: PathBuf,
    /// Optional allow-list of repo dir names (`$SPEC_REPOS`, CSV). Empty = all.
    restrict: BTreeSet<String>,
    ttl: Duration,
    cache: Mutex<Option<Cached>>,
}

impl SpecBackend {
    /// Build from env:
    ///   SPEC_SOURCE_ROOT     the git-synced tree of repos (default ".").
    ///   SPEC_REPOS           CSV allow-list of repo dir names (default: all).
    ///   SPEC_INDEX_TTL_SECS  index cache TTL (default 30).
    pub fn from_env() -> Self {
        let source_root =
            PathBuf::from(std::env::var("SPEC_SOURCE_ROOT").unwrap_or_else(|_| ".".to_string()));
        let restrict = std::env::var("SPEC_REPOS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let ttl = std::env::var("SPEC_INDEX_TTL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        Self {
            source_root,
            restrict,
            ttl: Duration::from_secs(ttl),
            cache: Mutex::new(None),
        }
    }

    pub fn source_root(&self) -> &Path {
        &self.source_root
    }

    /// The memoized estate index (rebuilt when older than the TTL).
    fn index(&self) -> Arc<Index> {
        {
            let guard = self.cache.lock().unwrap();
            if let Some(c) = guard.as_ref() {
                if c.built.elapsed() < self.ttl {
                    return c.index.clone();
                }
            }
        }
        let index = Arc::new(self.build_index());
        let mut guard = self.cache.lock().unwrap();
        *guard = Some(Cached {
            built: Instant::now(),
            index: index.clone(),
        });
        index
    }

    fn build_index(&self) -> Index {
        let mut idx = Index::default();
        let repos = match list_repos(&self.source_root, &self.restrict) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(root = %self.source_root.display(), error = %e, "cannot read source root");
                return idx;
            }
        };
        for (repo, dir) in repos {
            match scan_repo(&repo, &dir) {
                Ok(mut scan) => {
                    idx.specs.append(&mut scan.specs);
                    idx.modules.append(&mut scan.modules);
                    idx.contracts.append(&mut scan.contracts);
                }
                Err(e) => {
                    tracing::warn!(repo, error = %e, "repo scan failed; marking unreachable");
                    idx.unreachable.push(repo);
                }
            }
        }
        idx.specs
            .sort_by(|a, b| (&a.repo, &a.module, &a.path).cmp(&(&b.repo, &b.module, &b.path)));
        idx.modules
            .sort_by(|a, b| (&a.repo, &a.module).cmp(&(&b.repo, &b.module)));
        idx.contracts
            .sort_by(|a, b| (&a.repo, &a.id).cmp(&(&b.repo, &b.id)));
        tracing::info!(
            specs = idx.specs.len(),
            modules = idx.modules.len(),
            contracts = idx.contracts.len(),
            unreachable = idx.unreachable.len(),
            "rebuilt spec index"
        );
        idx
    }

    // ── Query surface (filters from the memoized index) ───────────────────────

    pub fn list_specs(
        &self,
        repos: &[String],
        langs: &[i32],
        kinds: &[String],
    ) -> (Vec<Spec>, Vec<String>) {
        let idx = self.index();
        let specs = idx
            .specs
            .iter()
            .filter(|s| {
                (repos.is_empty() || repos.iter().any(|r| r == &s.repo))
                    && (langs.is_empty() || langs.contains(&s.lang))
                    && (kinds.is_empty() || kinds.iter().any(|k| k == &s.kind))
            })
            .cloned()
            .collect();
        (specs, idx.unreachable.clone())
    }

    pub fn list_module_status(&self, repos: &[String]) -> (Vec<ModuleStatus>, Vec<String>) {
        let idx = self.index();
        let modules = idx
            .modules
            .iter()
            .filter(|m| repos.is_empty() || repos.iter().any(|r| r == &m.repo))
            .cloned()
            .collect();
        (modules, idx.unreachable.clone())
    }

    pub fn list_contracts(&self, repos: &[String], only_uncited: bool) -> (Vec<Contract>, Vec<String>) {
        let idx = self.index();
        let contracts = idx
            .contracts
            .iter()
            .filter(|c| {
                (repos.is_empty() || repos.iter().any(|r| r == &c.repo))
                    && (!only_uncited || (!c.discharger.is_empty() && !c.cited))
            })
            .cloned()
            .collect();
        (contracts, idx.unreachable.clone())
    }

    /// GetSpec detail — the spec + its source + the exact `sorry` line numbers.
    pub fn get_spec(&self, repo: &str, path: &str) -> Option<(Spec, String, Vec<u32>)> {
        let idx = self.index();
        let spec = idx.specs.iter().find(|s| s.repo == repo && s.path == path)?.clone();
        let abs = self.source_root.join(repo).join(path);
        let body = std::fs::read_to_string(&abs).unwrap_or_default();
        let (_, lines) = count_sorries(&body);
        Some((spec, truncate(body), lines))
    }

    /// GetContract detail — the contract + its theorem module source + every
    /// `Discharges: <id>` citation site.
    pub fn get_contract(&self, repo: &str, id: &str) -> Option<(Contract, String, Vec<Citation>)> {
        let idx = self.index();
        let c = idx.contracts.iter().find(|c| c.repo == repo && c.id == id)?.clone();
        // Theorem source: the module's .lean file (module "A.B" -> lean/A/B.lean).
        let rel = format!("lean/{}.lean", c.module.replace('.', "/"));
        let src = std::fs::read_to_string(self.source_root.join(repo).join(&rel)).unwrap_or_default();
        let citations = find_citations(&self.source_root.join(repo), id);
        Some((c, truncate(src), citations))
    }
}

/// A single repo's contribution to the index.
#[derive(Default)]
struct RepoScan {
    specs: Vec<Spec>,
    modules: Vec<ModuleStatus>,
    contracts: Vec<Contract>,
}

/// Immediate subdirs of `root` that are candidate repos (skip hidden + bazel-*).
fn list_repos(root: &Path, restrict: &BTreeSet<String>) -> io::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with("bazel-") {
            continue;
        }
        if !restrict.is_empty() && !restrict.contains(&name) {
            continue;
        }
        out.push((name, entry.path()));
    }
    out.sort();
    Ok(out)
}

fn scan_repo(repo: &str, dir: &Path) -> io::Result<RepoScan> {
    // One pass: collect .lean files, BUILD files, and Discharges citations.
    let mut lean_files: Vec<(String, PathBuf)> = Vec::new();
    let mut build_files: Vec<(String, PathBuf)> = Vec::new();
    let mut cited: BTreeSet<String> = BTreeSet::new();
    collect(dir, dir, &mut lean_files, &mut build_files, &mut cited)?;
    if lean_files.is_empty() {
        return Ok(RepoScan::default());
    }

    // Parse lean_test/lean_emit targets -> map a full (repo-relative) src path to
    // (kind, label), and a module -> its lean_test label.
    let mut src_target: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut module_target: BTreeMap<String, String> = BTreeMap::new();
    for (build_rel, build_abs) in &build_files {
        let text = std::fs::read_to_string(build_abs).unwrap_or_default();
        if !text.contains("lean_test") && !text.contains("lean_emit") {
            continue;
        }
        let pkg = parent_dir(build_rel);
        for t in parse_lean_targets(&text) {
            let label = if pkg.is_empty() {
                format!("//:{}", t.name)
            } else {
                format!("//{}:{}", pkg, t.name)
            };
            for s in &t.srcs {
                src_target
                    .entry(join_rel(&pkg, s))
                    .or_insert((t.kind.clone(), label.clone()));
            }
            if t.kind == "lean_test" {
                if let Some(entry) = &t.entry {
                    module_target
                        .entry(module_of(&join_rel(&pkg, entry)))
                        .or_insert(label.clone());
                }
            }
        }
    }

    // Build a Spec per .lean file + roll up per module.
    let mut specs = Vec::new();
    // module -> (status, sorry_count, spec_count, target)
    let mut by_module: BTreeMap<String, (SpecStatus, u32, u32, String)> = BTreeMap::new();
    for (rel, abs) in &lean_files {
        let body = std::fs::read_to_string(abs).unwrap_or_default();
        let (sorry_count, _) = count_sorries(&body);
        let status = if sorry_count > 0 {
            SpecStatus::Sorry
        } else {
            SpecStatus::Green
        };
        let module = module_of(rel);
        let (kind, target) = src_target
            .get(rel)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new()));
        specs.push(Spec {
            repo: repo.to_string(),
            path: rel.clone(),
            lang: SpecLang::Lean as i32,
            kind,
            target,
            module: module.clone(),
            status: status as i32,
            sorry_count,
        });
        let e = by_module
            .entry(module.clone())
            .or_insert((SpecStatus::Green, 0, 0, String::new()));
        if status == SpecStatus::Sorry {
            e.0 = SpecStatus::Sorry;
        }
        e.1 += sorry_count;
        e.2 += 1;
        if e.3.is_empty() {
            if let Some(t) = module_target.get(&module) {
                e.3 = t.clone();
            }
        }
    }

    let module_status: BTreeMap<String, SpecStatus> =
        by_module.iter().map(|(m, v)| (m.clone(), v.0)).collect();

    let modules = by_module
        .into_iter()
        .map(|(module, (status, sorry, count, target))| ModuleStatus {
            repo: repo.to_string(),
            module,
            target,
            status: status as i32,
            sorry_count: sorry,
            spec_count: count,
        })
        .collect();

    // Contracts (best-effort; only repos with an Emits/Contracts.lean catalog).
    let contracts = lean_files
        .iter()
        .find(|(rel, _)| rel.ends_with("Emits/Contracts.lean"))
        .map(|(_, abs)| {
            let text = std::fs::read_to_string(abs).unwrap_or_default();
            parse_catalog(&text)
                .into_iter()
                .map(|r| {
                    let status = module_status
                        .get(&r.module)
                        .copied()
                        .unwrap_or(SpecStatus::Unknown);
                    Contract {
                        cited: !r.discharger.is_empty() && cited.contains(&r.id),
                        repo: repo.to_string(),
                        id: r.id,
                        name: r.name,
                        promise: r.promise,
                        module: r.module,
                        discharger: r.discharger,
                        status: status as i32,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(RepoScan {
        specs,
        modules,
        contracts,
    })
}

/// One recursive walk gathering .lean files, BUILD files, and `Discharges:`
/// citations (from .rs/.yml/.yaml). Skips bazel scratch + dep trees.
fn collect(
    root: &Path,
    dir: &Path,
    lean: &mut Vec<(String, PathBuf)>,
    builds: &mut Vec<(String, PathBuf)>,
    cited: &mut BTreeSet<String>,
) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if ft.is_dir() {
            if skip_dir(&name) {
                continue;
            }
            collect(root, &path, lean, builds, cited)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if name == "BUILD.bazel" || name == "BUILD" {
                builds.push((rel.clone(), path.clone()));
            }
            match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
                "lean" => lean.push((rel, path)),
                "rs" | "yml" | "yaml" => {
                    if let Ok(body) = std::fs::read_to_string(&path) {
                        cited.extend(scan_citations(&body));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// Directories never worth descending: bazel scratch, VCS, and dependency trees
/// (Lean's `.lake`/`lake-packages`, `target`, `node_modules`, …). `.github` is
/// deliberately kept — the workflow contracts (W1-W5) are cited there.
fn skip_dir(name: &str) -> bool {
    name.starts_with("bazel-")
        || matches!(
            name,
            ".git" | "target" | ".lake" | "lake-packages" | "node_modules" | ".venv" | ".cache"
        )
}

// ── Lean module + sorry helpers (mirror botnoc's authoritative checks) ────────

/// Derive a Lean module id from a repo-relative path: strip a leading `lean/`
/// source root and the `.lean` suffix, then `/` -> `.`.
/// `lean/Botnoc/Queries.lean` -> `Botnoc.Queries`.
fn module_of(rel: &str) -> String {
    let p = rel.strip_suffix(".lean").unwrap_or(rel);
    let p = p.strip_prefix("lean/").unwrap_or(p);
    p.replace('/', ".")
}

/// Blank out Lean comments, preserving line structure so line numbers survive.
///
/// `/- -/` nests in Lean, so this tracks depth rather than scanning for the
/// first terminator.
///
/// ⚠ Not string-literal aware. A `"-- "` inside a string would start a false
/// comment; no Lean source here does that, and the failure direction is to
/// UNDER-count sorries in that one file rather than to invent them everywhere.
fn strip_comments(body: &str) -> String {
    let b: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut i = 0usize;
    let mut depth = 0usize;

    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();

        if depth > 0 {
            if c == '-' && next == Some('/') {
                depth -= 1;
                out.push_str("  ");
                i += 2;
            } else if c == '/' && next == Some('-') {
                depth += 1;
                out.push_str("  ");
                i += 2;
            } else {
                out.push(if c == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }

        if c == '/' && next == Some('-') {
            depth += 1;
            out.push_str("  ");
            i += 2;
        } else if c == '-' && next == Some('-') {
            while i < b.len() && b[i] != '\n' {
                out.push(' ');
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Count `sorry` obligations. Returns (count, 1-based line numbers).
///
/// ⛔ COMMENTS ARE STRIPPED FIRST, and that is the whole point. Word-bounding
/// alone does not exclude prose: this counted the word "sorry" wherever it
/// appeared, so `Spec/Predicates.lean` — whose header comment explains that a
/// `sorry` is banned and how the gate turns it into a hard error — reported
/// THREE open obligations and a SORRY badge. Thirteen of fourteen modules were
/// flagged the same way, every one of them provably sorry-free: //lean:audit_
/// proofs_test asserts it textually AND every source carries
/// `set_option warningAsError true`.
///
/// So the pane whose subject is proof was reporting the opposite of the truth,
/// and it read as authoritative because it was specific. A file that documents
/// its own discipline must not be punished for saying the word.
fn count_sorries(body: &str) -> (u32, Vec<u32>) {
    let code = strip_comments(body);
    let mut lines = Vec::new();
    for (i, line) in code.lines().enumerate() {
        if line_has_word(line, "sorry") {
            lines.push((i as u32) + 1);
        }
    }
    (lines.len() as u32, lines)
}

/// True if `word` appears in `line` bounded by non-identifier chars.
fn line_has_word(line: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = line[start..].find(word) {
        let abs = start + pos;
        let before = line[..abs].chars().next_back();
        let after = line[abs + word.len()..].chars().next();
        let ok = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        if ok(before) && ok(after) {
            return true;
        }
        start = abs + word.len();
    }
    false
}

/// Find every `Discharges: A1, B2, …` directive in a source file — the citation
/// walk from botnoc `tests/contracts_cited/src/main.rs` (comment-leader aware, ids
/// must start uppercase).
fn scan_citations(body: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in body.lines() {
        let t = line.trim_start();
        let Some(rest) = ["///", "//!", "//", "*", "#"].iter().find_map(|p| t.strip_prefix(p)) else {
            continue;
        };
        let Some(ids) = rest.trim_start().strip_prefix("Discharges:") else {
            continue;
        };
        for piece in ids.split(',') {
            let id = piece.trim().trim_matches(|c: char| !c.is_alphanumeric());
            if !id.is_empty() && id.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                out.insert(id.to_string());
            }
        }
    }
    out
}

/// Every `Discharges: <id>` site for `id`, repo-relative (GetContract detail).
fn find_citations(repo_dir: &Path, id: &str) -> Vec<Citation> {
    let mut out = Vec::new();
    walk_citation_files(repo_dir, repo_dir, id, &mut out);
    out
}

fn walk_citation_files(root: &Path, dir: &Path, id: &str, out: &mut Vec<Citation>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !skip_dir(&name) {
                walk_citation_files(root, &path, id, out);
            }
            continue;
        }
        if !matches!(
            path.extension().and_then(|e| e.to_str()).unwrap_or(""),
            "rs" | "yml" | "yaml"
        ) {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (i, line) in body.lines().enumerate() {
            let t = line.trim_start();
            let Some(rest) = ["///", "//!", "//", "*", "#"].iter().find_map(|p| t.strip_prefix(p)) else {
                continue;
            };
            let Some(ids) = rest.trim_start().strip_prefix("Discharges:") else {
                continue;
            };
            if ids
                .split(',')
                .any(|p| p.trim().trim_matches(|c: char| !c.is_alphanumeric()) == id)
            {
                out.push(Citation {
                    path: path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/"),
                    line: (i as u32) + 1,
                });
            }
        }
    }
}

// ── Contract catalog parser (Botnoc.Emits.Contracts.lean) ─────────────────────

struct CatalogRow {
    id: String,
    name: String,
    promise: String,
    module: String,
    discharger: String,
}

/// Parse the Lean contract catalog: each record is
/// `{ id := "Q1", name := "...", promise := "...", module := "...", discharger := some "..."|none }`.
/// Split on the leading `id :=` of each record (the first field), then pull each
/// field's quoted value from that record's slice.
fn parse_catalog(text: &str) -> Vec<CatalogRow> {
    let mut rows = Vec::new();
    for chunk in text.split("id :=").skip(1) {
        let Some(id) = first_quoted(chunk) else {
            continue;
        };
        let discharger = match chunk.find("discharger :=") {
            Some(pos) => {
                let after = chunk[pos + "discharger :=".len()..].trim_start();
                if after.starts_with("none") {
                    String::new()
                } else {
                    first_quoted(after).unwrap_or_default()
                }
            }
            None => String::new(),
        };
        rows.push(CatalogRow {
            id,
            name: field_quoted(chunk, "name :=").unwrap_or_default(),
            promise: field_quoted(chunk, "promise :=").unwrap_or_default(),
            module: field_quoted(chunk, "module :=").unwrap_or_default(),
            discharger,
        });
    }
    rows
}

fn first_quoted(s: &str) -> Option<String> {
    let start = s.find('"')?;
    let rest = &s[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn field_quoted(chunk: &str, key: &str) -> Option<String> {
    let pos = chunk.find(key)?;
    first_quoted(&chunk[pos + key.len()..])
}

// ── Lean target (BUILD.bazel) parser ──────────────────────────────────────────

struct LeanTarget {
    kind: String,
    name: String,
    entry: Option<String>,
    srcs: Vec<String>,
}

/// Extract `lean_test(...)` / `lean_emit(...)` calls from a BUILD.bazel body.
/// Heuristic + best-effort (never fatal): resilient to in-flight layout, since a
/// file with no matched target still lists as a Spec with blank kind/target.
fn parse_lean_targets(text: &str) -> Vec<LeanTarget> {
    let mut out = Vec::new();
    for kind in ["lean_test", "lean_emit"] {
        let needle = format!("{}(", kind);
        let mut from = 0;
        while let Some(pos) = text[from..].find(&needle) {
            let open = from + pos + needle.len() - 1; // index of '('
            from = open + 1;
            let Some(block) = balanced(&text[open..]) else {
                continue;
            };
            let Some(name) = attr_string(block, "name") else {
                continue;
            };
            let mut srcs = attr_list(block, "srcs");
            if let Some(src) = attr_string(block, "src") {
                srcs.push(src);
            }
            out.push(LeanTarget {
                kind: kind.to_string(),
                name,
                entry: attr_string(block, "entry"),
                srcs,
            });
        }
    }
    out
}

/// Inner text of a `(...)` group that `s` begins with (depth-matched; ignores
/// parens inside strings, which BUILD attrs don't use).
fn balanced(s: &str) -> Option<&str> {
    let mut depth = 0i32;
    for (i, &b) in s.as_bytes().iter().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[1..i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// The slice just after `key =` (word-bounded key), or None.
fn find_attr<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(pos) = block[from..].find(key) {
        let abs = from + pos;
        let before = block[..abs].chars().next_back();
        let ok_before = before.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        let after = block[abs + key.len()..].trim_start();
        if ok_before && after.starts_with('=') {
            return Some(after[1..].trim_start());
        }
        from = abs + key.len();
    }
    None
}

fn attr_string(block: &str, key: &str) -> Option<String> {
    first_quoted(find_attr(block, key)?)
}

fn attr_list(block: &str, key: &str) -> Vec<String> {
    let Some(after) = find_attr(block, key) else {
        return Vec::new();
    };
    if !after.starts_with('[') {
        return Vec::new();
    }
    let end = after.find(']').unwrap_or(after.len());
    let mut inner = &after[1..end];
    let mut out = Vec::new();
    while let Some(q) = first_quoted(inner) {
        let qstart = inner.find('"').unwrap();
        let qend = inner[qstart + 1..].find('"').unwrap() + qstart + 1;
        out.push(q);
        inner = &inner[qend + 1..];
    }
    out
}

// ── small path helpers ────────────────────────────────────────────────────────

/// Repo-relative directory of a repo-relative file path.
fn parent_dir(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

/// Join a repo-relative package dir with a package-relative path.
fn join_rel(pkg: &str, rel: &str) -> String {
    if pkg.is_empty() {
        rel.to_string()
    } else {
        format!("{}/{}", pkg, rel)
    }
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_SOURCE_BYTES {
        // Back off to a char boundary — String::truncate panics mid-codepoint.
        let mut cut = MAX_SOURCE_BYTES;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… (truncated)\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⛔ Both directions. A gate only ever shown to accept is an assertion.
    ///
    /// The first half is the bug that shipped: 13 of 14 Lean modules were badged
    /// SORRY because their comments explain that `sorry` is forbidden.
    #[test]
    fn sorry_count_ignores_comments_and_still_sees_real_ones() {
        // Verbatim shape of Spec/Predicates.lean's header, which reported 3.
        let documented = "\
-- ⛔ MUST stay. `lean_test` DOES NOT CHECK PROOFS on its own: a `sorry` is a
-- *warning* and `lean` exits 0, so a file proving anything `by sorry` passes.
-- `declaration uses 'sorry'` into a hard error; audit_proofs_test asserts it.
set_option warningAsError true
theorem t : 1 = 1 := rfl
";
        assert_eq!(count_sorries(documented).0, 0, "prose must not count");

        // Block comments nest in Lean; the inner close must not end the outer.
        let nested = "/- outer /- inner sorry -/ still comment sorry -/\ntheorem t : 1 = 1 := rfl\n";
        assert_eq!(count_sorries(nested).0, 0, "nested block comments must not count");

        // …and the check must still catch the thing it exists for.
        let real = "-- a comment about sorry\ntheorem bad : 1 = 2 := by sorry\n";
        let (n, at) = count_sorries(real);
        assert_eq!(n, 1, "a real sorry must still be found");
        assert_eq!(at, vec![2], "and reported on its own line");
    }

    #[test]
    fn module_derivation_strips_lean_root() {
        assert_eq!(module_of("lean/Botnoc/Queries.lean"), "Botnoc.Queries");
        assert_eq!(module_of("lean/Agora/Mechanism.lean"), "Agora.Mechanism");
        assert_eq!(module_of("Pg/Ast.lean"), "Pg.Ast");
    }

    #[test]
    fn sorry_is_word_bounded() {
        let (n, lines) = count_sorries("theorem t := by\n  sorry\n-- sorryDetail is fine\n");
        assert_eq!(n, 1);
        assert_eq!(lines, vec![2]);
    }

    #[test]
    fn citations_parse_from_comments() {
        let body = "//! Discharges: Q1, Q2\nfn x() {}\n// Discharges: L3\n";
        let ids = scan_citations(body);
        assert!(ids.contains("Q1") && ids.contains("Q2") && ids.contains("L3"));
    }

    #[test]
    fn catalog_row_parse() {
        let text = r#"
def catalog : List Contract :=
  [ { id := "Q1", name := "inbox_all_open",
      promise := "Inbox returns only PRs whose state is OPEN.",
      module := "Botnoc.Queries",
      discharger := some "services/org/src/backend.rs::inbox" }
  , { id := "P1", name := "resolving_decreases",
      promise := "Resolving removes its closed-issue.",
      module := "Botnoc.Progress" }
  ]
"#;
        let rows = parse_catalog(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "Q1");
        assert_eq!(rows[0].module, "Botnoc.Queries");
        assert_eq!(rows[0].discharger, "services/org/src/backend.rs::inbox");
        assert_eq!(rows[1].id, "P1");
        assert_eq!(rows[1].discharger, ""); // no `some` -> system-level
    }

    #[test]
    fn lean_targets_parse() {
        let text = r#"
lean_test(
    name = "queries_test",
    srcs = ["Botnoc/Axioms.lean", "Botnoc/Queries.lean"],
    entry = "Botnoc/Queries.lean",
    deps = LAKE_DEPS,
)
"#;
        let ts = parse_lean_targets(text);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].kind, "lean_test");
        assert_eq!(ts[0].name, "queries_test");
        assert_eq!(ts[0].entry.as_deref(), Some("Botnoc/Queries.lean"));
        assert_eq!(ts[0].srcs.len(), 2);
    }
}
