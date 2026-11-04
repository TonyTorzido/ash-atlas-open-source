// ASN -> network class for the mismatch signals (NATIVE_ANTISPOOF_BUILD_PLAN.md section 5).
// Data-driven: curated ASN tables first, then org-name heuristics for hosting/VPN and
// satellite. Anything else is "unknown" (not mobile for the shared-network block;
// country-level, like mobile, for the IP/GPS mismatch).
// The tables are best effort and meant to grow; a wrong or missing entry only moves a
// network between classes, it never grants or revokes anything on its own.

export type AsnClass = "mobile" | "fixed" | "hosting_vpn" | "satellite" | "unknown";

/** Satellite ISPs: IPs geolocate to ground stations, so no location rule applies. */
export const SATELLITE_ASNS: ReadonlySet<number> = new Set([
  14593, // SpaceX Starlink
  45700, // Starlink (APAC)
  27277, // Starlink
  7155, // Viasat
  6621, // Hughes Network Systems
  22351 // Intelsat
]);

/** Major mobile carriers (CGNAT: many unrelated users share one prefix). */
export const MOBILE_ASNS: ReadonlySet<number> = new Set([
  21928, // T-Mobile US
  393503, // T-Mobile US
  22394, // Verizon Wireless
  6167, // Verizon Wireless
  20057, // AT&T Mobility
  10507, // Sprint
  3651, // Sprint PCS
  812, // Rogers
  852, // TELUS
  1273, // Vodafone
  25135, // Vodafone UK
  3209, // Vodafone Germany
  6805, // Telefonica Germany (O2)
  35540, // Orange France (mobile)
  9498, // Bharti Airtel
  55836, // Reliance Jio
  38266, // Vodafone Idea
  17676, // SoftBank
  9605, // NTT Docomo
  2516, // KDDI
  9808, // China Mobile
  56040, // China Mobile
  56041, // China Mobile
  56046, // China Mobile
  137539, // China Mobile
  28403, // Claro Brazil
  26615, // TIM Brazil
  27699, // Vivo Brazil
  16135, // Turkcell
  34984 // Turkcell
]);

/** Large fixed-line residential/business ISPs where the IP point tracks the customer. */
export const FIXED_ASNS: ReadonlySet<number> = new Set([
  7922, // Comcast
  7018, // AT&T
  701, // Verizon (FiOS)
  20115, // Charter/Spectrum
  11426, // Charter/Spectrum
  12271, // Charter/Spectrum
  22773, // Cox
  209, // CenturyLink/Lumen
  6128, // Optimum
  5650, // Frontier
  2856, // BT
  5089, // Virgin Media
  3320, // Deutsche Telekom
  3215, // Orange France
  12322, // Free (France)
  3352, // Telefonica Spain
  3269, // Telecom Italia
  1136, // KPN
  3303, // Swisscom
  8447, // A1 Telekom Austria
  4713, // NTT OCN
  4134, // China Telecom
  9829 // BSNL
]);

/** Cloud, hosting and VPN/proxy providers. */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  16509, // Amazon
  14618, // Amazon
  8075, // Microsoft
  15169, // Google
  396982, // Google Cloud
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  63949, // Linode/Akamai
  20473, // Vultr
  13335, // Cloudflare
  9009, // M247
  60068, // Datacamp/CDN77
  46606, // Unified Layer
  31898, // Oracle Cloud
  45090, // Tencent Cloud
  37963, // Alibaba Cloud
  209103, // Proton AG
  39351, // 31173 Services (Mullvad)
  136787 // Tefincom (NordVPN)
]);

const SATELLITE_ORG = /starlink|space exploration technologies|viasat|hughes ?net|oneweb|inmarsat|iridium|telesat/iu;
const HOSTING_ORG = new RegExp(
  [
    "hosting",
    "hoster",
    "cloud",
    "data ?cent(?:er|re)s?",
    "colocation",
    "\\bcolo\\b",
    "\\bvps\\b",
    "vpn",
    "\\bproxy\\b",
    "dedicated server",
    "web services",
    "\\bservers?\\b",
    "digitalocean",
    "linode",
    "vultr",
    "hetzner",
    "\\bovh",
    "leaseweb",
    "choopa",
    "\\bm247\\b",
    "contabo",
    "scaleway",
    "nordvpn",
    "expressvpn",
    "mullvad",
    "proton ?(?:ag|vpn)",
    "surfshark",
    "private ?internet ?access",
    "ipvanish",
    "cyberghost",
    "tefincom",
    "quadranet",
    "colocrossing",
    "psychz",
    "amazon",
    "microsoft",
    "google"
  ].join("|"),
  "iu"
);

export function classifyAsn(asn: number | null | undefined, organization?: string | null): AsnClass {
  if (typeof asn === "number") {
    if (SATELLITE_ASNS.has(asn)) return "satellite";
    if (MOBILE_ASNS.has(asn)) return "mobile";
    if (HOSTING_ASNS.has(asn)) return "hosting_vpn";
    if (FIXED_ASNS.has(asn)) return "fixed";
  }
  const org = organization?.trim();
  if (org) {
    if (SATELLITE_ORG.test(org)) return "satellite";
    if (HOSTING_ORG.test(org)) return "hosting_vpn";
  }
  return "unknown";
}
