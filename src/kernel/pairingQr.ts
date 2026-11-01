import { toDataURL } from "qrcode";

/** Scannable PNG data URL. Black modules on white, error correction M. */
export function pairingQrDataUrl(uri: string): Promise<string> {
  return toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
