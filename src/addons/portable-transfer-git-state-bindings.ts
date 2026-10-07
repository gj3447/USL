/** Owner-selected local proposals for the working bytes of a verified CP03 restore. */
import { gitRestoreBindingInternals, type CleanGitRestoreBindingRequest } from "./portable-transfer-git-bindings.js"
import { recheckGitStateRestore, type GitStateRestoreResult } from "./portable-transfer-git-state-restore.js"

export type GitStateRestoreBindingRequest = CleanGitRestoreBindingRequest

/** Stable resource/representation IDs remain; revisionId is the pinned state receipt URN. */
export async function rebindGitStateRestore(restore: GitStateRestoreResult, input: GitStateRestoreBindingRequest) {
  // The proposal helper captures inputs before its first await and rechecks the entire restore twice.
  return gitRestoreBindingInternals.proposeBindings(restore, input, {
    schema: "usl-git-state-restore-bindings/v1", freshness: "PINNED_STATE_SNAPSHOT", recheck: recheckGitStateRestore,
    includeStateReceipts: true,
  })
}
