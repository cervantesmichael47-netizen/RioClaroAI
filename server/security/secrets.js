import { SecretClient } from '@azure/keyvault-secrets';

class AppServiceManagedIdentityCredential {
  #cachedToken;

  async getToken(scopes) {
    const now = Date.now();
    if (this.#cachedToken && this.#cachedToken.expiresOnTimestamp > now + 60_000) {
      return this.#cachedToken;
    }

    const endpoint = process.env.IDENTITY_ENDPOINT;
    const identityHeader = process.env.IDENTITY_HEADER;
    if (endpoint && identityHeader) {
      const url = new URL(endpoint);
      url.searchParams.set('api-version', '2019-08-01');
      const requestedScope = Array.isArray(scopes) ? scopes[0] : scopes;
      url.searchParams.set('resource', String(requestedScope).replace(/\/\.default$/, ''));
      if (process.env.AZURE_CLIENT_ID) url.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
      const response = await fetch(url, {
        headers: { 'X-IDENTITY-HEADER': identityHeader },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Managed identity token request failed.');
      const tokenResponse = await response.json();
      if (typeof tokenResponse.access_token !== 'string' || !Number.isFinite(Number(tokenResponse.expires_on))) {
        throw new Error('Managed identity returned an invalid token response.');
      }
      this.#cachedToken = {
        token: tokenResponse.access_token,
        expiresOnTimestamp: Number(tokenResponse.expires_on) * 1000,
      };
      return this.#cachedToken;
    }

    const localToken = process.env.AZURE_KEY_VAULT_ACCESS_TOKEN;
    if (localToken) {
      return { token: localToken, expiresOnTimestamp: now + 60_000 };
    }
    throw new Error('Azure managed identity or a local Key Vault access token is required.');
  }
}

export async function loadKeyVaultSecrets() {
  const vaultUrl = process.env.KEY_VAULT_URL?.trim();
  const secretNames = process.env.KEY_VAULT_SECRET_NAMES?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  if (!vaultUrl && secretNames.length === 0) return { configured: false };
  if (!vaultUrl || secretNames.length === 0 || !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/?$/i.test(vaultUrl)) {
    throw new Error('La configuración de Key Vault requiere KEY_VAULT_URL y una lista KEY_VAULT_SECRET_NAMES válida.');
  }
  if (secretNames.some((name) => !/^FOUNDRY_[A-Z0-9_]{1,120}$/.test(name))) {
    throw new Error('KEY_VAULT_SECRET_NAMES solo admite nombres de secretos FOUNDRY_*.');
  }

  const client = new SecretClient(vaultUrl, new AppServiceManagedIdentityCredential());
  for (const name of secretNames) {
    try {
      const secret = await client.getSecret(name);
      if (secret.value) process.env[name] = secret.value;
    } catch {
      throw new Error(`No se pudo obtener el secreto ${name} desde Key Vault. Revisa la identidad administrada y los permisos del almacén.`);
    }
  }
  return { configured: true };
}
