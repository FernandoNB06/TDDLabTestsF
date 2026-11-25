// Compatibilidad: sincronizar mediante el backend, sin logs locales.
import { runCommitSync } from './branchSyncCommit.js';
await runCommitSync();
