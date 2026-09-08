// The order system's "Forgot your password?" flow calls Keel's built-in
// requestPasswordReset with the frontend's /reset-password page as redirectUrl.
// Keel only accepts redirects that are allow-listed under auth.passwordResetUrl
// in keelconfig.yaml; with that key missing every request failed with
// "auth.passwordResetUrl must be configured". These tests pin the config.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';

const RESET_PAGE = 'http://localhost:3000/reset-password';

beforeEach(resetDatabase);

describe('password reset request', () => {
    test('accepts the frontend reset page as redirectUrl', async () => {
        await models.identity.create({ email: 'simon@example.test', password: 'original-pass-1' });

        await expect(
            actions.requestPasswordReset({ email: 'simon@example.test', redirectUrl: RESET_PAGE }),
        ).resolves.toBeDefined();
    });

    test('rejects a redirectUrl outside the allow-list', async () => {
        await models.identity.create({ email: 'simon@example.test', password: 'original-pass-1' });

        await expect(
            actions.requestPasswordReset({ email: 'simon@example.test', redirectUrl: 'https://evil.example/reset' }),
        ).rejects.toThrow();
    });

    test('does not reveal whether the email is known', async () => {
        await expect(
            actions.requestPasswordReset({ email: 'nobody@example.test', redirectUrl: RESET_PAGE }),
        ).resolves.toBeDefined();
    });
});
