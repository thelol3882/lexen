/**
 * Ambient module stubs for peer dependencies.
 * These packages are peerDependencies of @thelol3882/lexen-live; the consuming
 * Next.js app installs them.  These stubs let `tsc --noEmit` pass in the live
 * package without duplicating heavy packages in devDependencies.
 */

declare module 'next-intl' {
    import type { ComponentType, ReactNode } from 'react';

    export interface AbstractIntlMessages {
        [key: string]: string | AbstractIntlMessages;
    }

    export interface NextIntlClientProviderProps {
        locale: string;
        messages?: AbstractIntlMessages;
        timeZone?: string;
        now?: Date;
        children?: ReactNode;
        formats?: unknown;
        onError?: (error: unknown) => void;
        getMessageFallback?: (info: unknown) => string;
        [key: string]: unknown;
    }

    export const NextIntlClientProvider: ComponentType<NextIntlClientProviderProps>;
}
