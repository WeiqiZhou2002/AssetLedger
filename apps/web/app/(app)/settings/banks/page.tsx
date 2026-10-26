import { permanentRedirect } from "next/navigation";

export default function BankConnections() {
  permanentRedirect("/statements?tab=sync");
}
