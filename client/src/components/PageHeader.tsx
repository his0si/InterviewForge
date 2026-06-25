import type { ReactNode } from "react";

// 페이지 상단 인사말/제목 영역(.dash-greeting) 공용 컴포넌트.
export default function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="dash-greeting">
      <h1>{title}</h1>
      {children != null && children !== false && <p>{children}</p>}
    </div>
  );
}
