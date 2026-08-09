import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { GoogleAnalytics } from "@next/third-parties/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Vercel Web Analytics for both the web app and the desktop shell is collected
// by the deployment at getrescript.com, so the two show up in one dashboard.
// The Electron app:// shell cannot serve the default /_vercel/insights paths at
// all, so the SDK is pointed at absolute URLs through that project's CORS
// proxy. Left unset in development so the SDK loads its debug script and logs
// to the console instead of reporting local traffic.
const analyticsHost =
  process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_HOST ?? "https://www.getrescript.com";
const analyticsProps =
  process.env.NODE_ENV === "production"
    ? {
      scriptSrc: `${analyticsHost}/api/va/script.js`,
      endpoint: `${analyticsHost}/api/va`,
    }
    : {};

const title = "Rescript — edit videos like you edit text";
const description =
  "A fully offline, open-source transcript-based video editor. Transcribe with Whisper, cut by deleting words, export with ffmpeg — on your device.";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.getrescript.com"),
  title,
  description,
  openGraph: {
    type: "website",
    siteName: "Rescript",
    url: "/",
    title,
    description,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Rescript — a transcript-based video editor running in the browser",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

/** Apply stored appearance before paint to avoid a light→dark flash. */
const appearanceBootScript = `(function(){try{if(localStorage.getItem("rescript.appearance")==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`;
const localeBootScript = `(function(){try{var p=localStorage.getItem("rescript.ui-locale")||"system";var l=p;if(p==="system"){var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];l="en";for(var i=0;i<a.length;i++){var v=(a[i]||"").toLowerCase();if(v==="zh"||v.indexOf("zh-")===0){l="zh-CN";break}if(v==="en"||v.indexOf("en-")===0){l="en";break}}}document.documentElement.lang=l==="zh-CN"?"zh-CN":"en"}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="appearance-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: appearanceBootScript }}
        />
        <Script
          id="locale-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: localeBootScript }}
        />
      </head>
      <body className="min-h-full">
        {children}
        <Analytics {...analyticsProps} />
      </body>
      <GoogleAnalytics gaId="G-WZ055S858C" />
    </html>
  );
}
