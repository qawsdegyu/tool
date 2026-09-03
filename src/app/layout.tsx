import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FB Agent — CDP Tool',
  description: 'Facebook support form automation agent with BigPipe param extraction',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
