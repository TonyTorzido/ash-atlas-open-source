# Remote runtime PNG content

Remote PNG content packs contain artwork only; JavaScript, CSS, and other executable content are
not accepted. The pack includes the existing `chat-crest-lion` slot and can include one artwork
replacement for an existing player skin tone. A skin replacement does not add a selectable skin
tone or change server-owned player appearance state.

## Build and select a pack

Build from the slot's current PNG or another authored PNG file. `--id` binds that entry to an
existing runtime PNG registration. A skin replacement uses a stable content ID supplied by the
content author and targets an existing tone; its PNG bytes and content ID live in the manifest,
not in a compiled client image-path slot:

```powershell
pnpm content:packs build --id chat-crest-lion --source <authored-png> --select
pnpm content:packs build --id chat-crest-lion --source <crest-png> `
  --skin-tone dark --skin-id dusk-body-2030 --skin-source <new-skin-png> --select
pnpm content:packs:validate
```

The builder verifies PNG bytes, writes each blob under its SHA-256, writes a deterministic manifest
under its manifest hash, and atomically updates `apps/server/content/runtime-png-packs/active.json`.
Keep the same `--skin-id` when replacing that artwork again; pack identity changes with the bytes,
while the data ID remains stable. Build another pack into the same content directory to select B,
then point `active.json` back to A to restore it. `RUNTIME_PNG_CONTENT_PACK` can pin the server to
a specific pack ID; `RUNTIME_PNG_CONTENT_DIRECTORY` changes the content directory when deployment
stores it elsewhere. The server build copies the verified content directory into its `dist` artifact.

## Client activation

The client requests the manifest through the existing registered slot. The server returns it only
when that slot is compatible with the shared registry; skin entries must target an existing catalog
tone with a separate artwork key. The client bounds the pack to 5 MiB, verifies the manifest
identity and every PNG SHA-256, decodes each image, and stores the staged, active, and previous pack
records in IndexedDB. It changes the active and previous pointers in one transaction, then installs
blob URL overrides before mounting gameplay. The dark tone keeps its server-owned `dark` ID while
the manifest supplies the replacement PNG and its author-chosen content ID. A session keeps its
selected pack for its lifetime; a later launch can select B or return to cached A without a client
build. Failed updates leave the last verified pack available and bundled PNGs remain the fallback.
