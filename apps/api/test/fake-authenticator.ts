/** A software passkey: real P-256 keys and signatures, so tests exercise real verification. */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
const b64u = (data: Buffer) => data.toString('base64url');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function counterBytes(counter: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(counter);
  return out;
}

function cborText(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x60 + text.length]), Buffer.from(text)]);
}

export interface FakeOverrides {
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
}

export class FakeAuthenticator {
  readonly credentialId = randomBytes(32);
  /** Public so a test can wind it back, as a cloned authenticator would. */
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly origin = 'http://localhost:5173',
    private readonly rpId = 'localhost',
  ) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private clientData(type: string, challenge: unknown, o: FakeOverrides): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: o.origin ?? this.origin, crossOrigin: false }),
    );
  }

  private flags(o: FakeOverrides, extra = 0): Buffer {
    return Buffer.from([FLAG_UP | (o.userVerified === false ? 0 : FLAG_UV) | extra]);
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
  }

  /** What `startRegistration()` returns in a browser. */
  register(options: Record<string, unknown>, o: FakeOverrides = {}): Record<string, unknown> {
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, o);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(Buffer.from(o.rpId ?? this.rpId)),
      this.flags(o, FLAG_AT),
      counterBytes(this.counter),
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      Buffer.from([0x58, authData.length]),
      authData,
    ]);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** What `startAuthentication()` returns in a browser. */
  sign(options: Record<string, unknown>, o: FakeOverrides = {}): Record<string, unknown> {
    this.counter += 1;
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, o);
    const authData = Buffer.concat([
      sha256(Buffer.from(o.rpId ?? this.rpId)),
      this.flags(o),
      counterBytes(this.counter),
    ]);
    const signature = createSign('SHA256')
      .update(Buffer.concat([authData, sha256(clientDataJSON)]))
      .sign(this.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}
