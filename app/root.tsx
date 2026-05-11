import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700&display=swap"
        />
        <Meta />
        <Links />
      </head>
      <body
        style={{
          margin: 0,
          backgroundColor: "#efe8de",
          color: "#1c1c16",
          fontFamily: '"Manrope", Inter, system-ui, sans-serif',
        }}
      >
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
