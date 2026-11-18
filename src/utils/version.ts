import { getOperatingSystem } from "@hooks/useOperatingSystem";
import dayjs from "dayjs";
import { OperatingSystem } from "@/interfaces/OperatingSystem";
import { NetbirdRelease } from "@/interfaces/Version";

const GITHUB_API_ENDPOINT = "https://api.github.com";
// The repository whose latest release peers are compared with. A fork that
// publishes its own client builds sets this at build time.
const NETBIRD_RELEASES_REPO =
  process.env.NEXT_PUBLIC_NETBIRD_RELEASES_REPO || "netbirdio/netbird";
const LATEST_RELEASE_CHECK_INTERVAL_IN_MINUTES = 10;

export const getLatestNetbirdRelease = async (
  release?: NetbirdRelease,
): Promise<NetbirdRelease | undefined> => {
  const runFetch =
    release === undefined ||
    release.last_checked === undefined ||
    dayjs(release.last_checked).isBefore(
      dayjs().subtract(LATEST_RELEASE_CHECK_INTERVAL_IN_MINUTES, "minute"),
    );

  if (runFetch) {
    try {
      const data = (await fetch(
        `${GITHUB_API_ENDPOINT}/repos/${NETBIRD_RELEASES_REPO}/releases/latest`,
      ).then((response) => response.json())) as any;

      return {
        latest_version: data.name,
        last_checked: new Date(),
        url: data.html_url as string,
      } as NetbirdRelease;
    } catch (e) {
      console.warn(e);
      return undefined;
    }
  } else {
    return release;
  }
};

/**
 * Split a version string into its numeric release components.
 *
 * Handles every shape NetBird components report: an optional "v" prefix, semver
 * build metadata ("0.77.0+enterprise.1" on enterprise management builds), a CI
 * build suffix ("0.76.3-31256681241"), and pre-release labels ("0.60.0-rc.1").
 * Everything after the release itself is dropped — build metadata carries no
 * precedence in semver, and a pre-release of X.Y.Z is treated as X.Y.Z so a
 * feature gate keyed on a release also holds for its release candidates.
 *
 * Splitting on "." alone (the previous behaviour) left the suffix inside a
 * component, so "0.77.0+enterprise.1" parsed as [0, 77, 0, 1] — smuggling the
 * build number in as a fourth release component. That ranked today's tags
 * correctly only by coincidence; dropping the suffix removes the guesswork.
 */
const releaseParts = (version: string): number[] =>
  version
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/, 1)[0]
    .split(".")
    .map((part) => {
      const parsed = parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });

/**
 * The pre-release label of a version ("3" in "0.83.1-3"),
 * without build metadata; empty for a plain release.
 */
const preRelease = (version: string): string => {
  const bare = version.trim().replace(/^v/i, "").split("+", 1)[0];
  const dash = bare.indexOf("-");
  return dash === -1 ? "" : bare.slice(dash + 1);
};

/**
 * Semver precedence of two pre-release labels: numeric identifiers compare
 * numerically, others as text, numeric before text, and a label that is a
 * prefix of the other comes first. Returns <0, 0 or >0.
 */
const comparePreRelease = (a: string, b: string): number => {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const an = /^\d+$/.test(as[i]);
    const bn = /^\d+$/.test(bs[i]);
    if (an && bn) {
      const d = parseInt(as[i], 10) - parseInt(bs[i], 10);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1;
    }
  }
  return as.length - bs.length;
};

/**
 * Compare semantic versions.
 * Returns true if version >= minVersion.
 */
export const compareVersions = (
  version: string,
  minVersion: string,
): boolean => {
  const vParts = releaseParts(version);
  const minParts = releaseParts(minVersion);

  for (let i = 0; i < Math.max(vParts.length, minParts.length); i++) {
    const vPart = vParts[i] || 0;
    const minPart = minParts[i] || 0;

    if (vPart > minPart) return true;
    if (vPart < minPart) return false;
  }

  return true;
};

/**
 * Whether a version string names a non-release build. Mirrors the management
 * server's version.IsDevelopmentVersion: the literal "development" plus the
 * "ci-" and "dev-" prefixes it stamps on snapshot builds ("ci-7470fbdd").
 *
 * Such a string carries no release to compare against. releaseParts() reads
 * its leading word as 0, so without this check every snapshot install would
 * see the current release as newer and nag about an update forever.
 */
export const isDevelopmentVersion = (version: string): boolean => {
  const bare = version.trim().replace(/^v/i, "");
  return (
    bare.startsWith("development") ||
    bare.startsWith("ci-") ||
    bare.startsWith("dev-")
  );
};

/**
 * Returns true when `latest` is a strictly newer release than `current` — i.e.
 * an update is available. Only release components decide: an enterprise build
 * ("0.77.0+enterprise.1") is up to date against the "0.77.0" it was built from,
 * matching how the management server evaluates it server-side.
 *
 * Development and snapshot builds never report an update, in either position.
 */
export const isNewerVersion = (current: string, latest: string): boolean => {
  if (!current || !latest) return false;
  if (isDevelopmentVersion(current) || isDevelopmentVersion(latest)) {
    return false;
  }

  const currentParts = releaseParts(current);
  const latestParts = releaseParts(latest);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  // Same release. Only when both carry a pre-release label are they ordered
  // by it, as semver does: fork builds (0.83.1-2 → 0.83.1-3)
  // and release candidates. A label on one side only stays "up to date", so a
  // CI or fork build is not told to "update" to the plain release it is built
  // from.
  const currentPre = preRelease(current);
  const latestPre = preRelease(latest);
  if (currentPre && latestPre) {
    return comparePreRelease(latestPre, currentPre) > 0;
  }

  return false;
};

/**
 * Check if peer as routing peer is supported by the provided version and operating system.
 * Routing peers are supported on Windows, macOS, iOS & Android starting from NetBird v0.36.6+.
 * @param version
 * @param os
 */
export const isRoutingPeerSupported = (version: string, os: string) => {
  const operatingSystem = getOperatingSystem(os);
  if (operatingSystem == OperatingSystem.LINUX) return true;
  if (version == "development") return true;
  return compareVersions(version, "0.36.6");
};

/**
 * Check if native SSH is supported.
 * Supported starting from NetBird v0.60.0+.
 * @param version
 */
export const isNativeSSHSupported = (version: string) => {
  if (version == "development") return true;
  return compareVersions(version, "0.60.0");
};

/**
 * Check if NetBird SSH protocol is supported.
 * Supported starting from NetBird v0.61.0+.
 * @param version
 */
export const isNetbirdSSHProtocolSupported = (version: string) => {
  if (version == "development") return true;
  return compareVersions(version, "0.61.0");
};
