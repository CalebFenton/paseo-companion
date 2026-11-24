import { z } from "zod";

/** The fields read from Paseo's workspace descriptors; `extend` it for more. Entries that do not fit are skipped. */
export const workspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullish(),
  projectRootPath: z.string(),
  workspaceDirectory: z.string().optional(),
  archivingAt: z.string().nullish(),
});
type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export type ActiveWorkspace<Entry extends WorkspaceEntry = WorkspaceEntry> = Entry & {
  /** What Paseo shows: the title given to the workspace, else its name. */
  label: string;
  /** Where its files are: its worktree, else its project's checkout. */
  directory: string;
};

/** The `paseo.workspaces.list()` entries that fit `schema` and are not being archived. */
export function activeWorkspaces<Entry extends WorkspaceEntry>(entries: unknown, schema: z.ZodType<Entry>): ActiveWorkspace<Entry>[] {
  return z
    .array(z.unknown())
    .catch([])
    .parse(entries)
    .flatMap((raw) => {
      const entry = schema.safeParse(raw);
      if (!entry.success || entry.data.archivingAt) return [];
      return [
        {
          ...entry.data,
          label: entry.data.title || entry.data.name,
          directory: entry.data.workspaceDirectory ?? entry.data.projectRootPath,
        },
      ];
    });
}
