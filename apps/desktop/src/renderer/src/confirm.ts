/**
 * One confirmation the panel shows before an action it cannot take back. The
 * text names the exact target — a path, an upstream, a `remote/branch` — so the
 * user confirms what happens, not that they are sure.
 */
export interface ConfirmRequest {
  /** One line naming the action and its exact target. */
  title: string;
  /** What exactly happens, one paragraph per entry. */
  body: readonly string[];
  /** Label of the accept button: the verb of the action itself. */
  acceptLabel: string;
  /** Destructive actions start the focus on Cancel, so Enter never fires them. */
  destructive: boolean;
}
