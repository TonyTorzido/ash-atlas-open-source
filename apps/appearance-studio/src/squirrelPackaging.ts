import { Buffer } from "node:buffer";

export interface SquirrelReleaseBaseline {
  packageName: string | null;
  version: string | null;
}

export interface SquirrelReleasePlan extends SquirrelReleaseBaseline {
  noDelta: boolean;
}

const zipEndOfCentralDirectorySignature = 0x06054b50;
const zipCentralDirectoryEntrySignature = 0x02014b50;
const zipEndOfCentralDirectoryMinimumSize = 22;
const zipEndOfCentralDirectoryMaximumCommentSize = 0xffff;
const zipCentralDirectoryEntryMinimumSize = 46;
const whitespacePattern = /\s/u;
const fullPackagePattern = /^(.+)-(\d+\.\d+\.\d+)-full\.nupkg$/iu;
const deltaPackagePattern = /^.+-(\d+\.\d+\.\d+)-delta\.nupkg$/iu;
const versionedPackagePattern = /^.+-\d+\.\d+\.\d+-(?:full|delta)\.nupkg$/iu;

export function squirrelZipEntryNames(contents: Uint8Array): string[] {
  const archive = Buffer.from(contents);
  const searchStart = Math.max(
    0,
    archive.length - zipEndOfCentralDirectoryMinimumSize - zipEndOfCentralDirectoryMaximumCommentSize
  );
  let endOfCentralDirectoryOffset = -1;
  for (let offset = archive.length - zipEndOfCentralDirectoryMinimumSize;
    offset >= searchStart;
    offset -= 1) {
    if (archive.readUInt32LE(offset) === zipEndOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }
  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("Squirrel package is not a valid ZIP archive.");
  }

  const entryCount = archive.readUInt16LE(endOfCentralDirectoryOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectoryOffset + 16);
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("Squirrel package ZIP64 archives are not supported for entry validation.");
  }
  if (centralDirectoryOffset + centralDirectorySize > archive.length) {
    throw new Error("Squirrel package ZIP central directory is truncated.");
  }

  const entryNames: string[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + zipCentralDirectoryEntryMinimumSize > archive.length ||
      archive.readUInt32LE(offset) !== zipCentralDirectoryEntrySignature) {
      throw new Error("Squirrel package ZIP central directory entry is invalid.");
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nextOffset = offset + zipCentralDirectoryEntryMinimumSize + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length) {
      throw new Error("Squirrel package ZIP central directory entry is truncated.");
    }
    entryNames.push(archive.subarray(offset + zipCentralDirectoryEntryMinimumSize, offset +
      zipCentralDirectoryEntryMinimumSize + nameLength).toString("utf8"));
    offset = nextOffset;
  }
  return entryNames;
}

export function squirrelParserUnsafeEntryNames(entryNames: readonly string[]): string[] {
  return entryNames.filter((entryName) => whitespacePattern.test(entryName));
}

export function assertSquirrelDeltaEntryNames(entryNames: readonly string[]): void {
  const unsafeEntryNames = squirrelParserUnsafeEntryNames(entryNames);
  if (unsafeEntryNames.length === 0) return;
  throw new Error(
    "Squirrel delta package contains parser-breaking whitespace in entry name(s): " +
    unsafeEntryNames.join(", ")
  );
}

export function inspectSquirrelReleaseBaseline(
  releaseFileNames: readonly string[],
  currentVersion: string
): SquirrelReleaseBaseline {
  const candidates = releaseFileNames.flatMap((fileName) => {
    const match = fullPackagePattern.exec(fileName);
    if (!match || compareVersions(match[2]!, currentVersion) >= 0) return [];
    return [{ packageName: fileName, version: match[2]! }];
  });
  candidates.sort((left, right) => compareVersions(right.version!, left.version!));
  const baseline = candidates[0];
  return baseline ?? { packageName: null, version: null };
}

export function squirrelReleasePlan(
  releaseFileNames: readonly string[],
  currentVersion: string
): SquirrelReleasePlan {
  const baseline = inspectSquirrelReleaseBaseline(releaseFileNames, currentVersion);
  return {
    ...baseline,
    noDelta: baseline.packageName === null
  };
}

export function squirrelReleasePlanMessage(plan: SquirrelReleasePlan): string {
  if (plan.noDelta) {
    return "No prior full Squirrel package baseline found; generating a full-only installer " +
      "for fresh install and recovery.";
  }
  return `Prior full Squirrel package ${plan.packageName} (${plan.version}) found; generating ` +
    "the current full package and a delta package.";
}

export function squirrelReleasePackageNames(
  releaseFileNames: readonly string[]
): string[] {
  return releaseFileNames.filter((fileName) => versionedPackagePattern.test(fileName));
}

export function squirrelReleasePackageNamesToRemoveBeforePackaging(
  releaseFileNames: readonly string[],
  baselinePackageName: string | null
): string[] {
  const baseline = baselinePackageName?.toLowerCase() ?? null;
  return squirrelReleasePackageNames(releaseFileNames)
    .filter((fileName) => fileName.toLowerCase() !== baseline);
}

export function squirrelReleasePackageNamesToRemoveAfterPackaging(
  releaseFileNames: readonly string[],
  currentVersion: string,
  baselinePackageName: string | null
): string[] {
  const baseline = baselinePackageName?.toLowerCase() ?? null;
  return squirrelReleasePackageNames(releaseFileNames).filter((fileName) => {
    if (fileName.toLowerCase() === baseline) return false;
    const fullPackage = fullPackagePattern.exec(fileName);
    if (fullPackage?.[2] === currentVersion) return false;
    const deltaPackage = deltaPackagePattern.exec(fileName);
    return deltaPackage?.[1] !== currentVersion;
  });
}

export function retainSquirrelReleaseManifest(
  contents: string,
  retainedPackageNames: readonly string[]
): string {
  const retained = new Set(retainedPackageNames.map((fileName) => fileName.toLowerCase()));
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  return contents.split(/\r?\n/u).filter((line) => {
    const fileName = line.trim().split(/\s+/u)[1];
    if (!fileName || !versionedPackagePattern.test(fileName)) return true;
    return retained.has(fileName.toLowerCase());
  }).join(newline);
}

function compareVersions(left: string, right: string): number {
  const leftParts = semanticVersion(left);
  const rightParts = semanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function semanticVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error(`Invalid Squirrel package version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
