import "./globals.css";

export const metadata = {
  title: "GitHub File Uploader • Yopandelreyz",
  description: "Upload ZIP/folder code to a fixed GitHub repo in a clean One UI-inspired flow.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
