"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
export function Field({ label, ...props }: React.ComponentProps<typeof Input> & { label: string }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}
export function SelectField({
  label,
  children,
  ...props
}: React.ComponentProps<"select"> & { label: string }) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus:ring-2 focus:ring-ring disabled:opacity-60"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
export function NotesField({
  label = "备注",
  ...props
}: React.ComponentProps<"textarea"> & { label?: string }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm focus:ring-2 focus:ring-ring"
        maxLength={2000}
        {...props}
      />
    </div>
  );
}
export function FormSheet({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto px-5 pb-10 sm:max-w-xl">
        <SheetHeader className="px-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
export async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "操作失败，请重试");
  return result as T;
}
export function useLedgerMutation() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(operation: () => Promise<void>, message = "已保存") {
    setPending(true);
    setError("");
    try {
      await operation();
      router.refresh();
      toast.success(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "暂时无法完成，请重试";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}
export function FormError({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="text-sm leading-6 text-destructive">
      {error}
    </p>
  ) : null;
}
export function textField(data: FormData, name: string) {
  return String(data.get(name) ?? "").trim();
}
