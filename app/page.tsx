import Terminal from "@/components/Terminal";
import { HelpProvider } from "@/contexts/HelpContext";
import HelpOverlays from "@/components/help/HelpOverlays";

export default function Page() {
  return (
    <HelpProvider>
      <HelpOverlays />
      <Terminal />
    </HelpProvider>
  );
}
