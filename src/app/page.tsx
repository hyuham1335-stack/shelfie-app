export default function Home() {
  return (
    <main className="mx-auto max-w-md space-y-8 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-ink">Shelfie</h1>
        <p className="text-sm text-body">
          책장을 찍으면 책등에서 제목을 읽어내고, 지금 기분에 맞는 책을
          골라드려요.
        </p>
      </header>

      <section className="rounded-md border border-line bg-card p-4">
        <p className="text-sm text-subtle">
          아직 구현 전입니다. 구현 계획은 <code>/docs/TRD.md</code>의 시스템
          요구사항 표(TR-001~TR-013)를 따릅니다.
        </p>
      </section>
    </main>
  );
}
