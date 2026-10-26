"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-xl font-medium">暂时无法打开账簿</h1>
      <p className="my-4 text-sm text-muted-foreground">请稍后重试，或检查服务连接。</p>
      <Button onClick={reset}>重试</Button>
    </main>
  );
}
