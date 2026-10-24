import { useOmni } from "../store";
import { Computer, Ide, Workflows } from "./build";
import { Market } from "./market";
import { BotsHub, Chat, Profiles } from "./chat";
import { Capabilities } from "./capabilities";
import { Fleet, Providers } from "./connect";
import { Memory } from "./memory";
import { Skills } from "./skills";
import { Onboarding, Vault } from "./gates";
import { Billing, Extensions, Repair, Wallet } from "./ops";
import { SettingsScreen } from "./settings";
import UniversalMcpAcpMeshStudio from "../components/UniversalMcpAcpMeshStudio";
import Harness2Studio from "../components/Harness2Studio";

export function Screen() {
  const screen = useOmni((s) => s.screen);
  switch (screen) {
    case "onboarding":
      return <Onboarding />;
    case "vault":
      return <Vault />;
    case "chat":
      return <Chat />;
    case "bots":
      return <BotsHub />;
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
      return <Extensions />;
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
