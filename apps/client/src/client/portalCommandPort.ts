export interface PortalCommandPort {
  use(
    portalId: string,
    expectedPortalRevision?: string,
    options?: Readonly<{ approach?: "normal" | "immediate" }>
  ): string | null;
  cancel(): boolean;
}
