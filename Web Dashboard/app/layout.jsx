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
};

export default function RootLayout({ children }) {
    return (
        <html lang="en" className={poppins.variable}>
            <body>{children}</body>
        </html>
    );
}
