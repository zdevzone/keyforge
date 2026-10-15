/** Small raster avatars live with the user record, so backups and replicas carry
 * them without a separate public upload directory. SVG and arbitrary data URLs
 * are deliberately excluded. Existing HTTPS avatar URLs remain supported. */
export function isProfileImage(value: string): boolean {
  if (value === "") return true;
  if (value.startsWith("https://")) {
    try {
      return Boolean(new URL(value).hostname) && value.length <= 2048;
    } catch {
      return false;
    }
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > 350000) return false;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 256 * 1024 || bytes.toString("base64") !== match[2]) return false;
  if (match[1] === "png")
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (match[1] === "jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
