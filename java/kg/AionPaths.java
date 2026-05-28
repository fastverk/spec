package kg;

import java.nio.file.Path;
import java.nio.file.Paths;

import dev.dirs.ProjectDirectories;

/**
 * Platform-correct cache / config / data directories for Aion tooling.
 *
 * Wraps {@link dev.dirs.ProjectDirectories} (Java port of the Rust
 * {@code directories} crate) so callers don't have to assemble their
 * own XDG / macOS / Windows paths.
 *
 * Layout per platform (with {@code qualifier="io"}, {@code organization="Savvi"},
 * {@code application="aion"}):
 *
 *   Linux:   $XDG_CACHE_HOME/aion           or $HOME/.cache/aion
 *            $XDG_CONFIG_HOME/aion          or $HOME/.config/aion
 *            $XDG_DATA_HOME/aion            or $HOME/.local/share/aion
 *   macOS:   $HOME/Library/Caches/io.Savvi.aion
 *            $HOME/Library/Application Support/io.Savvi.aion
 *   Windows: %LOCALAPPDATA%\Savvi\aion\cache
 *            %APPDATA%\Savvi\aion\config
 *            %LOCALAPPDATA%\Savvi\aion\data
 *
 * Override via {@code AION_CACHE_DIR} / {@code AION_CONFIG_DIR} /
 * {@code AION_DATA_DIR} env vars when CI or tests need a fixed path.
 */
public final class AionPaths {

    private static final ProjectDirectories DIRS =
        ProjectDirectories.from("io", "Savvi", "aion");

    private AionPaths() {}

    /** Author-local cache for transient artifacts (LLM responses,
     *  intermediate computations). Safe to delete. */
    public static Path cacheDir() {
        String env = System.getenv("AION_CACHE_DIR");
        return env != null && !env.isEmpty()
            ? Paths.get(env)
            : Paths.get(DIRS.cacheDir);
    }

    /** Per-author configuration (API keys when stored locally,
     *  user preferences). Not safe to delete. */
    public static Path configDir() {
        String env = System.getenv("AION_CONFIG_DIR");
        return env != null && !env.isEmpty()
            ? Paths.get(env)
            : Paths.get(DIRS.configDir);
    }

    /** Persistent author data not appropriate for cache or config
     *  (e.g., long-lived KG snapshots, fine-tune training corpora). */
    public static Path dataDir() {
        String env = System.getenv("AION_DATA_DIR");
        return env != null && !env.isEmpty()
            ? Paths.get(env)
            : Paths.get(DIRS.dataDir);
    }
}
