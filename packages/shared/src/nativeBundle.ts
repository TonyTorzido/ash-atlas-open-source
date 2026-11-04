import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const positiveInteger = z.number().int().positive().safe();

export const nativeBundleDescriptorSchema = z.object({
  bundleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  platform: z.enum(["ios", "android"]),
  url: z.string().url().startsWith("https://"),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u).min(1),
  sizeBytes: positiveInteger,
  artifactType: z.enum(["zip", "manifest"]),
  clientSha: sha,
  serverSha: sha,
  generation: z.string().regex(/^test\/t[0-9]{3,}$/u),
  minShellBuild: positiveInteger,
  protocolMin: positiveInteger,
  protocolMax: positiveInteger
}).strict().refine((descriptor) => descriptor.protocolMin <= descriptor.protocolMax, {
  message: "protocol minimum exceeds maximum"
});

export type NativeBundleDescriptor = Readonly<z.infer<typeof nativeBundleDescriptorSchema>>;

export type NativeBundlePointer = Readonly<{
  ios: Readonly<{ current: NativeBundleDescriptor; previous: NativeBundleDescriptor | null }>;
  android: Readonly<{ current: NativeBundleDescriptor; previous: NativeBundleDescriptor | null }>;
}>;

export function validateNativeBundleDescriptor(value: unknown): NativeBundleDescriptor {
  return nativeBundleDescriptorSchema.parse(value);
}
