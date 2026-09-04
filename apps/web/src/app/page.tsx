import Link from "next/link";
import { cls } from "@/lib/ui";

export default function Home() {
  return (
    <div className="rb-auth">
      <div className="rb-auth__card">
        <span className={cls.eyebrow}>RAGBench</span>
        <h1>Which part of your RAG pipeline lost the answer?</h1>
        <p className={cls.muted} style={{ marginTop: 8 }}>
          Run the same test set against several retrieval configs, then diagnose each miss down to
          chunking, embedding, retrieval depth, or an unanswerable question.
        </p>
        <div className="rb-auth__form">
          <Link href="/login" className={cls.btnPrimary}>
            Log in
          </Link>
          <Link href="/signup" className={cls.btn}>
            Create an account
          </Link>
        </div>
      </div>
    </div>
  );
}
