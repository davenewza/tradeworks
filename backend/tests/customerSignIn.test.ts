// A customer reaches their price lists through the User their sign-in identity
// is linked to (User.customer). Since Keel runtime 0.489, a password identity
// whose email hasn't been verified is unlinked from its User at sign-in, and
// the token response says email_verification_required. The order system's
// LoginForm keys off that flag to send the verification email, and relies on
// verification linking the identity back to the customer's existing User by
// email. These tests pin both halves.
//
// Previously the frontend answered a null getMe by calling createMe, which
// inserted a User linked to no identity: the customer saw "No Customer
// Assigned" and every sign-in added another orphan row.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';

const EMAIL = 'buyer@customer.test';
const PASSWORD = 'customer-pass-1';

beforeEach(resetDatabase);

async function signIn() {
    const response = await fetch(`${process.env.KEEL_TESTING_AUTH_API_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'password', username: EMAIL, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    return response.json();
}

// A customer set up before 0.489: their password identity was linked to a User
// carrying their email and customer, without the email ever being verified.
async function existingCustomerSignIn() {
    const customer = await models.customer.create({ name: 'Acme Interiors' });
    const user = await models.user.create({ email: EMAIL, customerId: customer.id });

    await signIn(); // creates the password identity
    const identity = await models.identity.findOne({ email: EMAIL, issuer: 'https://keel.so' });
    await models.identity.update({ id: identity!.id }, { userId: user.id });

    return { customer, user, identityId: identity!.id };
}

describe('customer password sign-in', () => {
    test('an unverified email is unlinked from the customer and asked to verify', async () => {
        const { identityId } = await existingCustomerSignIn();

        const tokens = await signIn();

        expect(tokens.email_verification_required).toBe(true);
        const identity = await models.identity.findOne({ id: identityId });
        expect(identity!.userId).toBeNull();
        await expect(actions.withAuthToken(tokens.access_token).getMe()).resolves.toBeNull();
    });

    test('verifying the email links the sign-in back to the same customer', async () => {
        const { customer, user, identityId } = await existingCustomerSignIn();
        await signIn(); // unlinked, as in the test above

        // Stands in for the emailed /auth/verify-email link
        await models.identity.update({ id: identityId }, { emailVerified: true });
        const tokens = await signIn();

        expect(tokens.email_verification_required).toBeUndefined();
        const me = await actions.withAuthToken(tokens.access_token).getMe();
        expect(me!.id).toBe(user.id);
        expect(me!.customerId).toBe(customer.id);
        expect(await models.user.findMany()).toHaveLength(1);
    });
});
