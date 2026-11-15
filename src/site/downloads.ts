export type Download = {
  id: string;
  label: string;
  href: string;
  note: string;
};

const BASE = "https://github.com/harishgouda9/Ronic-os/releases/download/v2.2.0";

// shortcut: filenames include the release version, update them when the tag changes.
export const downloads: Download[] = [
  {
    id: "windows",
    label: "Windows",
    href: `${BASE}/Ronic.OS_2.2.0_x64-setup.exe`,
    note: "Run the setup file once. It adds a Start Menu entry and a desktop shortcut. Windows may ask you to confirm the installer.",
  },
  {
    id: "mac",
    label: "Mac",
    href: `${BASE}/Ronic.OS_2.2.0_aarch64.dmg`,
    note: "Open the disk image, then move Ronic OS to Applications.",
  },
  {
    id: "macIntel",
    label: "Intel Mac",
    href: `${BASE}/Ronic.OS_2.2.0_x64.dmg`,
    note: "Open the disk image, then move Ronic OS to Applications.",
  },
  {
    id: "linux",
    label: "Linux",
    href: `${BASE}/Ronic.OS_2.2.0_amd64.deb`,
    note: "Install the .deb package.",
  },
  {
    id: "appimage",
    label: "Linux AppImage",
    href: `${BASE}/Ronic.OS_2.2.0_amd64.AppImage`,
    note: "Make the AppImage executable, then run it.",
  },
];

export function primaryDownload(userAgent: string): Download {
  const text = userAgent.toLowerCase();
  const id = text.includes("mac") ? "mac" : text.includes("linux") && !text.includes("android") ? "linux" : "windows";
  return downloads.find((item) => item.id === id) ?? downloads[0];
}
