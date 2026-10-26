import { Button } from "@/components/ui/button";
export function DuplicateChoices({
  pending,
  onReauthorize,
  onAdd,
}: {
  pending: boolean;
  onReauthorize: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Button disabled={pending} onClick={onReauthorize}>
        重新授权已有连接
      </Button>
      <Button
        variant="outline"
        className="h-auto text-left whitespace-normal"
        disabled={pending}
        onClick={onAdd}
      >
        仍然添加新连接（会占用一个新的 Plaid Item）
      </Button>
    </div>
  );
}
