import './globals.css';
import { Poppins } from 'next/font/google';

const poppins = Poppins({
    subsets: ['latin'],
    weight: ['300', '400', '500', '600', '700', '800'],
    variable: '--font-poppins',
    display: 'swap',
});

export const metadata = {
    title: 'YullyHub — Loader',
    description: 'Live control surface for the C++ loader',
    icons: {
        icon: '/YullyLogo.png',
    },
};

export default function RootLayout({ children }) {
    return (
        <html lang="en" className={poppins.variable}>
            <head>
                {/* Tailwind (CDN) — used by the PSN-style layout classes */}
                <script src="https://cdn.tailwindcss.com" defer></script>
                {/* Flickity carousel (CDN) — powers the PSN-style game slider */}
                <link
                    rel="stylesheet"
                    href="https://cdn.jsdelivr.net/npm/flickity@2.3.0/dist/flickity.min.css"
                />
            </head>
            <body>{children}</body>
        </html>
    );
}
