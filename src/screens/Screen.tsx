import { Suspense, lazy } from "react";
import { useRonic } from "../store";

// Each screen ships as its own chunk. The chat, memory, skills, and connect
// screens together were most of the old 1.8 MB main bundle; lazy-loading them
// cuts first-paint to the shell plus whatever screen the session restores to.
const Onboarding = lazy(() => import("./gates").then((m) => ({ default: m.Onboarding })));
const Vault = lazy(() => import("./gates").then((m) => ({ default: m.Vault })));
const Chat = lazy(() => import("./chat").then((m) => ({ default: m.Chat })));
const MessagingGateway = lazy(() => import("../components/RonicMessagingGateway"));
const Profiles = lazy(() => import("./chat").then((m) => ({ default: m.Profiles })));
const Providers = lazy(() => import("./connect").then((m) => ({ default: m.Providers })));
const Fleet = lazy(() => import("./connect").then((m) => ({ default: m.Fleet })));
const Memory = lazy(() => import("./memory").then((m) => ({ default: m.Memory })));
const Skills = lazy(() => import("./skills").then((m) => ({ default: m.Skills })));
const UniversalMcpAcpMeshStudio = lazy(() => import("../components/UniversalMcpAcpMeshStudio"));
const Harness2Studio = lazy(() => import("../components/Harness2Studio"));
const Capabilities = lazy(() => import("./capabilities").then((m) => ({ default: m.Capabilities })));
const Ide = lazy(() => import("./build").then((m) => ({ default: m.Ide })));
const Computer = lazy(() => import("./build").then((m) => ({ default: m.Computer })));
const Workflows = lazy(() => import("./build").then((m) => ({ default: m.Workflows })));
const Market = lazy(() => import("./market").then((m) => ({ default: m.Market })));
const Wallet = lazy(() => import("../components/RonicWalletAndQuantTerminal"));
const ProfileScreen = lazy(() => import("./ops").then((m) => ({ default: m.ProfileScreen })));
const Repair = lazy(() => import("../components/RonicSelfRepairAndSentinels"));
const Billing = lazy(() => import("./plan").then((m) => ({ default: m.PlanHub })));
const SettingsScreen = lazy(() => import("./settings").then((m) => ({ default: m.SettingsScreen })));

function Opening() {
  return (
    <div className="screen opening">
      <span className="opening-dot" aria-hidden="true" />
      <p className="muted">Opening…</p>
    </div>
  );
}

export function Screen() {
  const screen = useRonic((s) => s.screen);
  return (
    <Suspense fallback={<Opening />}>
      <div className="screen-mount" key={screen}>
        {render(screen)}
      </div>
    </Suspense>
  );
}

function render(screen: string) {
  switch (screen) {
    case "onboarding":
      return <Onboarding />;
    case "vault":
      return <Vault />;
    case "chat":
      return <Chat />;
    case "bots":
      return <MessagingGateway />;
    case "profiles":
      return <Profiles />;
    case "providers":
      return <Providers />;
    case "memory":
      return <Memory />;
    case "skills":
      return <Skills />;
    case "mesh":
      return <UniversalMcpAcpMeshStudio />;
    case "harness2":
      return <Harness2Studio />;
    case "capabilities":
      return <Capabilities />;
    case "fleet":
      return <Fleet />;
    case "ide":
      return <Ide />;
    case "computer":
      return <Computer />;
    case "workflows":
      return <Workflows />;
    case "market":
      return <Market />;
    case "wallet":
      return <Wallet />;
    case "extensions":
      return <ProfileScreen />;
    case "repair":
      return <Repair />;
    case "billing":
      return <Billing />;
    case "settings":
      return <SettingsScreen />;
    default:
      return <Chat />;
  }
}
