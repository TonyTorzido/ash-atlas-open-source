# Import-boundary report after Wave 2

At the t087 Wave 2 baseline, the architecture scan covered 367 production TypeScript files and 986
resolved relative imports. It found three strongly connected components and three registered Wave
1 exceptions.

Wave 2 now scans 400 production files and 1,049 imports. It reports two unchanged shared-package
cycles:

1. shared classes -> combat -> progression -> classes;
2. shared equipment <-> equipment-balance.

The server Resource Vision store/queue cycle is gone. Shared job payload, claimed-job, and store
interfaces live in `resourceVisionJobContracts.ts`; both queue and store import that neutral file.
Durable job identity, leases, retries, and database schema did not change.

All three Wave 1 exceptions are gone:

1. Population V2 operations and HTTP rollout import the neutral operation port.
2. WorldRuntime imports only its adjacent narrow connection port.
3. Population preparation tooling requests explicit diagnostic composition outside production.

The architecture scan reports zero findings and zero registered exceptions. It additionally rejects
new shared-to-app edges, domain-to-transport imports, V1 production composition, multiple World-lock
readers, raw handler send/serialization, handler authority construction, transport Population
authority construction, publisher bypass, incomplete delivery policy, and HTTP route-family
authority construction.

The two remaining shared cycles are intentionally reserved for Wave 3 because their public
contracts span client/server code. No new cycle was introduced.
