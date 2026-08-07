import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PAYLOAD_SHA256,
  S3Error,
  canonicalQueryString,
  canonicalUri,
  createS3Client,
  deriveSigningKeyChain,
  isNotFound,
  parseS3ErrorBody,
  sha256Hex,
  signRequest,
  uriEncode,
} from "../src/s3.mjs";

/* -------------------------------------------------------------------------- */
/* Official AWS SigV4 test-suite vectors                                       */
/*                                                                             */
/* Copied verbatim from awslabs/aws-c-auth tests/aws-signing-test-suite/v4/*,  */
/* which is the canonical published SigV4 suite. Each case ships a context.json */
/* (credentials/region/service/timestamp), the expected canonical request, the  */
/* expected string-to-sign and the expected signature. A SigV4 bug is otherwise  */
/* invisible until a real server rejects the request, so these are the gate.     */
/* -------------------------------------------------------------------------- */

const SUITE_CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  date: "2015-08-30T12:36:00Z",
};

const VECTORS = [
  {
    name: "get-vanilla",
    request: { method: "GET", url: "https://example.amazonaws.com/", headers: {} },
    signContentSha256Header: false,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    canonicalRequest: [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com",
      "x-amz-date:20150830T123600Z",
      "",
      "host;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n"),
    stringToSign: [
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      "20150830/us-east-1/service/aws4_request",
      "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    ].join("\n"),
    signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=host;x-amz-date, "
      + "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  },
  {
    // Header values are trimmed and internal whitespace runs collapse — even inside quotes.
    name: "get-header-value-trim",
    request: {
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: { "My-Header1": " value1 ", "My-Header2": '"a   b   c"' },
    },
    signContentSha256Header: false,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    canonicalRequest: [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com",
      "my-header1:value1",
      'my-header2:"a b c"',
      "x-amz-date:20150830T123600Z",
      "",
      "host;my-header1;my-header2;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n"),
    stringToSign: [
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      "20150830/us-east-1/service/aws4_request",
      "a726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7",
    ].join("\n"),
    signature: "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
    authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=host;my-header1;my-header2;x-amz-date, "
      + "Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
  },
  {
    // Query parameters sort by key after encoding, regardless of wire order.
    name: "get-vanilla-query-order-key-case",
    request: {
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      headers: {},
    },
    signContentSha256Header: false,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    canonicalRequest: [
      "GET",
      "/",
      "Param1=value1&Param2=value2",
      "host:example.amazonaws.com",
      "x-amz-date:20150830T123600Z",
      "",
      "host;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n"),
    stringToSign: [
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      "20150830/us-east-1/service/aws4_request",
      "816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
    ].join("\n"),
    signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=host;x-amz-date, "
      + "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  },
  {
    // sign_body: true — the x-amz-content-sha256 header is itself part of the signature,
    // which is the mode every S3 request uses.
    name: "post-x-www-form-urlencoded",
    request: {
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "13",
      },
    },
    signContentSha256Header: true,
    payloadHash: "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
    canonicalRequest: [
      "POST",
      "/",
      "",
      "content-length:13",
      "content-type:application/x-www-form-urlencoded",
      "host:example.amazonaws.com",
      "x-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      "x-amz-date:20150830T123600Z",
      "",
      "content-length;content-type;host;x-amz-content-sha256;x-amz-date",
      "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
    ].join("\n"),
    stringToSign: [
      "AWS4-HMAC-SHA256",
      "20150830T123600Z",
      "20150830/us-east-1/service/aws4_request",
      "b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb",
    ].join("\n"),
    signature: "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, "
      + "Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
  },
];

for (const vector of VECTORS) {
  test(`AWS SigV4 suite vector: ${vector.name}`, () => {
    const signed = signRequest({
      ...vector.request,
      payloadHash: vector.payloadHash,
      signContentSha256Header: vector.signContentSha256Header,
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      region: SUITE_CREDENTIALS.region,
      service: SUITE_CREDENTIALS.service,
      date: SUITE_CREDENTIALS.date,
    });

    assert.equal(signed.canonicalRequest, vector.canonicalRequest, "canonical request mismatch");
    assert.equal(signed.stringToSign, vector.stringToSign, "string to sign mismatch");
    assert.equal(signed.signature, vector.signature, "signature mismatch");
    assert.equal(signed.headers.authorization, vector.authorization, "authorization header mismatch");
  });
}

test("the post vector's payload hash really is SHA256 of the body", () => {
  assert.equal(
    sha256Hex("Param1=value1"),
    "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
  );
  assert.equal(sha256Hex(""), EMPTY_PAYLOAD_SHA256);
});

// The documented AWS "derive a signing key" worked example: secret
// wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, date 20120215, region us-east-1, service iam.
// Pinning the whole chain localises a break to the exact HMAC round that regressed.
test("the derived signing key chain matches the documented example", () => {
  const chain = deriveSigningKeyChain({
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    dateStamp: "20120215",
    region: "us-east-1",
    service: "iam",
  });

  assert.equal(
    chain.kSecret.toString("hex"),
    "41575334774a616c725855746e46454d492f4b374d44454e472b62507852666943594558414d504c454b4559",
  );
  assert.equal(
    chain.kDate.toString("hex"),
    "969fbb94feb542b71ede6f87fe4d5fa29c789342b0f407474670f0c2489e0a0d",
  );
  assert.equal(
    chain.kRegion.toString("hex"),
    "69daa0209cd9c5ff5c8ced464a696fd4252e981430b10e3d3fd8e2f197d7a70c",
  );
  assert.equal(
    chain.kService.toString("hex"),
    "f72cfd46f26bc4643f06a11eabb6c0ba18780c19a8da0c31ace671265e3c87fa",
  );
  assert.equal(
    chain.kSigning.toString("hex"),
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  );
});

/* -------------------------------------------------------------------------- */
/* Canonicalisation primitives                                                 */
/* -------------------------------------------------------------------------- */

test("uriEncode follows the AWS rules, not encodeURIComponent", () => {
  assert.equal(uriEncode("a-zA-Z0-9-._~"), "a-zA-Z0-9-._~");
  assert.equal(uriEncode("hello world"), "hello%20world", "space is %20, never +");
  // encodeURIComponent leaves these alone; AWS requires them encoded.
  assert.equal(uriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(uriEncode("a/b"), "a%2Fb");
  assert.equal(uriEncode("a/b", { encodeSlash: false }), "a/b");
  assert.equal(uriEncode("é"), "%C3%A9", "multi-byte UTF-8 encodes per byte");
});

test("canonicalUri encodes each segment exactly once and keeps the slashes", () => {
  assert.equal(canonicalUri("/photos/Jan/sample.jpg"), "/photos/Jan/sample.jpg");
  assert.equal(canonicalUri("/test$file.text"), "/test%24file.text");
  assert.equal(canonicalUri("/a b/c+d"), "/a%20b/c%2Bd");
  assert.equal(canonicalUri(""), "/");
  // S3 must not normalise dot segments away — they are legal key characters.
  assert.equal(canonicalUri("/a/./b"), "/a/./b");
});

test("canonicalQueryString sorts after encoding and keeps empty values", () => {
  assert.equal(canonicalQueryString("?b=2&a=1"), "a=1&b=2");
  assert.equal(canonicalQueryString("?acl"), "acl=");
  assert.equal(canonicalQueryString(new URLSearchParams("prefix=J&max-keys=2")), "max-keys=2&prefix=J");
  assert.equal(canonicalQueryString(""), "");
  // Duplicate keys break the tie on value.
  assert.equal(canonicalQueryString("?a=2&a=1"), "a=1&a=2");
});

/* -------------------------------------------------------------------------- */
/* URL construction                                                            */
/* -------------------------------------------------------------------------- */

test("path style addresses MinIO as endpoint/bucket/key", () => {
  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
  });

  assert.equal(client.forcePathStyle, true, "a non-AWS endpoint defaults to path style");
  assert.equal(client.objectUrl("user1/a.png"), "http://127.0.0.1:9000/media/user1/a.png");
  assert.equal(client.objectUrl("/leading/slash.png"), "http://127.0.0.1:9000/media/leading/slash.png");
  assert.equal(client.objectUrl("has space.png"), "http://127.0.0.1:9000/media/has%20space.png");
});

test("virtual-host style addresses AWS as bucket.s3.region.amazonaws.com/key", () => {
  const client = createS3Client({
    region: "eu-west-2",
    bucket: "agentctl-media",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
  });

  assert.equal(client.forcePathStyle, false, "an AWS endpoint defaults to virtual-host style");
  assert.equal(
    client.objectUrl("user1/a.png"),
    "https://agentctl-media.s3.eu-west-2.amazonaws.com/user1/a.png",
  );
});

test("forcePathStyle overrides the endpoint-based default in both directions", () => {
  const pathOnAws = createS3Client({
    region: "us-east-1",
    bucket: "bkt",
    accessKeyId: "k",
    secretAccessKey: "s",
    forcePathStyle: true,
  });
  assert.equal(pathOnAws.objectUrl("k.txt"), "https://s3.us-east-1.amazonaws.com/bkt/k.txt");

  const virtualOnMinio = createS3Client({
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "bkt",
    accessKeyId: "k",
    secretAccessKey: "s",
    forcePathStyle: false,
  });
  assert.equal(virtualOnMinio.objectUrl("k.txt"), "http://bkt.localhost:9000/k.txt");
});

test("the signed host header matches the URL, including a non-default port", () => {
  const signed = signRequest({
    method: "GET",
    url: "http://127.0.0.1:9000/media/a.png",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    date: "2015-08-30T12:36:00Z",
  });
  assert.equal(signed.headers.host, "127.0.0.1:9000");
  assert.match(signed.canonicalRequest, /^host:127\.0\.0\.1:9000$/mu);

  const https = signRequest({
    method: "GET",
    url: "https://b.s3.us-east-1.amazonaws.com/a.png",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    date: "2015-08-30T12:36:00Z",
  });
  assert.equal(https.headers.host, "b.s3.us-east-1.amazonaws.com", "default port is omitted");
});

test("S3 requests always carry x-amz-content-sha256 and x-amz-date", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://b.s3.us-east-1.amazonaws.com/a.png",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    date: "2015-08-30T12:36:00Z",
  });
  assert.equal(signed.headers["x-amz-content-sha256"], EMPTY_PAYLOAD_SHA256);
  assert.equal(signed.headers["x-amz-date"], "20150830T123600Z");
  assert.match(signed.signedHeaders, /x-amz-content-sha256/u);
});

/* -------------------------------------------------------------------------- */
/* Request shape via a stubbed fetch                                           */
/* -------------------------------------------------------------------------- */

function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: url.toString(), init });
    return responder(url.toString(), init);
  };
  impl.calls = calls;
  return impl;
}

function xmlResponse(status, body, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "application/xml", ...headers } });
}

test("putObject signs the body, sets content-type and encodes metadata", async () => {
  const fetchImpl = recordingFetch(() => new Response(null, {
    status: 200,
    headers: { etag: '"abc123"' },
  }));

  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    fetchImpl,
  });

  const body = Buffer.from("hello world");
  const result = await client.putObject({
    key: "u1/a.txt",
    body,
    contentType: "text/plain",
    metadata: { MediaId: "med_123", sha256: "deadbeef" },
  });

  assert.equal(result.etag, '"abc123"');
  assert.equal(result.sizeBytes, 11);
  assert.equal(result.sha256, sha256Hex(body));

  const [call] = fetchImpl.calls;
  assert.equal(call.url, "http://127.0.0.1:9000/media/u1/a.txt");
  assert.equal(call.init.method, "PUT");
  assert.equal(call.init.headers["content-type"], "text/plain");
  assert.equal(call.init.headers["x-amz-meta-mediaid"], "med_123");
  assert.equal(call.init.headers["x-amz-meta-sha256"], "deadbeef");
  assert.equal(call.init.headers["x-amz-content-sha256"], sha256Hex(body));
  assert.match(call.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//u);
  assert.equal(call.init.headers.host, undefined, "undici derives Host itself");
});

test("getObject returns the bytes plus metadata", async () => {
  const fetchImpl = recordingFetch(() => new Response(Buffer.from("payload"), {
    status: 200,
    headers: {
      "content-type": "image/png",
      etag: '"e"',
      "x-amz-meta-mediaid": "med_1",
    },
  }));

  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "k",
    secretAccessKey: "s",
    fetchImpl,
  });

  const object = await client.getObject({ key: "u1/a.png" });
  assert.equal(object.body.toString("utf8"), "payload");
  assert.equal(object.contentType, "image/png");
  assert.deepEqual(object.metadata, { mediaid: "med_1" });
  assert.equal(fetchImpl.calls[0].init.headers["x-amz-content-sha256"], EMPTY_PAYLOAD_SHA256);
});

test("headObject and deleteObject use the right verbs", async () => {
  const fetchImpl = recordingFetch((url, init) => (init.method === "HEAD"
    ? new Response(null, { status: 200, headers: { "content-length": "42", etag: '"e"' } })
    : new Response(null, { status: 204 })));

  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "k",
    secretAccessKey: "s",
    fetchImpl,
  });

  const head = await client.headObject({ key: "u1/a.png" });
  assert.equal(head.contentLength, 42);
  assert.equal(fetchImpl.calls[0].init.method, "HEAD");

  const removed = await client.deleteObject({ key: "u1/a.png" });
  assert.equal(removed.deleted, true);
  assert.equal(fetchImpl.calls[1].init.method, "DELETE");
});

test("metadata that would inject a header is refused", async () => {
  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "k",
    secretAccessKey: "s",
    fetchImpl: recordingFetch(() => new Response(null, { status: 200 })),
  });

  await assert.rejects(
    () => client.putObject({ key: "a", body: "x", metadata: { "bad\r\nname": "v" } }),
    /Invalid metadata name/u,
  );
  await assert.rejects(
    () => client.putObject({ key: "a", body: "x", metadata: { ok: "v\r\nx-amz-acl: public-read" } }),
    /Invalid metadata value/u,
  );
  await assert.rejects(() => client.putObject({ key: "a\nb", body: "x" }), /newlines/u);
});

/* -------------------------------------------------------------------------- */
/* Error handling                                                              */
/* -------------------------------------------------------------------------- */

const NO_SUCH_KEY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>u1/missing.png</Key>
  <RequestId>17A4E2B1C3D4E5F6</RequestId>
  <HostId>abc/def+ghi=</HostId>
</Error>`;

test("parseS3ErrorBody pulls the code out of an S3 XML error document", () => {
  const parsed = parseS3ErrorBody(NO_SUCH_KEY_XML);
  assert.equal(parsed.code, "NoSuchKey");
  assert.equal(parsed.message, "The specified key does not exist.");
  assert.equal(parsed.requestId, "17A4E2B1C3D4E5F6");
  assert.equal(parsed.hostId, "abc/def+ghi=");

  assert.equal(parseS3ErrorBody(""), null);
  assert.equal(parseS3ErrorBody("<html>nope</html>"), null);
});

test("a non-2xx response throws an S3Error carrying the parsed code", async () => {
  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "k",
    secretAccessKey: "s",
    fetchImpl: recordingFetch(() => xmlResponse(404, NO_SUCH_KEY_XML)),
  });

  const error = await client.getObject({ key: "u1/missing.png" }).then(
    () => null,
    (thrown) => thrown,
  );

  assert.ok(error instanceof S3Error);
  assert.equal(error.code, "NoSuchKey");
  assert.equal(error.statusCode, 404);
  assert.equal(error.requestId, "17A4E2B1C3D4E5F6");
  assert.equal(error.key, "u1/missing.png");
  assert.match(error.message, /NoSuchKey/u);
  assert.match(error.message, /The specified key does not exist/u);
  assert.equal(isNotFound(error), true);
});

test("an empty error body still yields a usable code (HEAD has no body)", async () => {
  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: "k",
    secretAccessKey: "s",
    fetchImpl: recordingFetch(() => new Response(null, { status: 404 })),
  });

  const error = await client.headObject({ key: "gone" }).then(() => null, (thrown) => thrown);
  assert.equal(error.code, "NotFound");
  assert.equal(error.statusCode, 404);
  assert.equal(isNotFound(error), true);
});

test("credentials never reach a thrown error or a request URL", async () => {
  const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
  const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

  const fetchImpl = recordingFetch(() => xmlResponse(
    403,
    "<Error><Code>SignatureDoesNotMatch</Code><Message>Denied</Message></Error>",
  ));

  const client = createS3Client({
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "media",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    fetchImpl,
  });

  const error = await client.putObject({ key: "u1/a.png", body: "x", contentType: "image/png" })
    .then(() => null, (thrown) => thrown);

  assert.ok(error instanceof S3Error);
  assert.equal(error.code, "SignatureDoesNotMatch");

  // Authentication is header-based, so nothing secret may appear in the URL...
  const requestUrl = fetchImpl.calls[0].url;
  assert.equal(requestUrl.includes(SECRET), false);
  assert.equal(requestUrl.includes(ACCESS_KEY), false);
  assert.equal(requestUrl.includes("X-Amz-Signature"), false, "header auth, not presigned");

  // ...nor in anything the error carries or that a log line would print.
  const surfaces = [
    error.message,
    String(error.stack),
    error.url ?? "",
    JSON.stringify({ ...error }),
    Object.values(error).map(String).join(" "),
  ];
  for (const surface of surfaces) {
    assert.equal(surface.includes(SECRET), false, "secret access key leaked");
    assert.equal(surface.includes(ACCESS_KEY), false, "access key id leaked");
  }
});

test("the client refuses to construct without credentials or with a bad bucket", () => {
  assert.throws(
    () => createS3Client({ region: "us-east-1", bucket: "media" }),
    /accessKeyId and secretAccessKey are required/u,
  );
  assert.throws(
    () => createS3Client({ region: "us-east-1", bucket: "../etc", accessKeyId: "k", secretAccessKey: "s" }),
    /Invalid bucket name/u,
  );
  assert.throws(
    () => createS3Client({ region: "us-east-1", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }),
    /Invalid bucket name/u,
    "S3 bucket names are at least 3 characters",
  );
  assert.throws(
    () => createS3Client({ bucket: "media", accessKeyId: "k", secretAccessKey: "s" }),
    /region is required/u,
  );
});

/* -------------------------------------------------------------------------- */
/* Round trip against a real S3-compatible server                              */
/*                                                                             */
/* Vectors prove the maths; only a real server proves the wire format. Runs     */
/* against MinIO when one is reachable, otherwise skips loudly.                 */
/* Start one with:                                                             */
/*   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \                */
/*     -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data              */
/* -------------------------------------------------------------------------- */

const LIVE = {
  endpoint: process.env.S3_TEST_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.S3_TEST_REGION ?? "us-east-1",
  bucket: process.env.S3_TEST_BUCKET ?? "agentctl-test",
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin",
};

async function ensureBucket() {
  const url = new URL(`/${LIVE.bucket}`, LIVE.endpoint);
  const signed = signRequest({
    method: "PUT",
    url,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    accessKeyId: LIVE.accessKeyId,
    secretAccessKey: LIVE.secretAccessKey,
    region: LIVE.region,
    service: "s3",
  });
  const { host: _host, ...headers } = signed.headers;
  const response = await fetch(url, { method: "PUT", headers, signal: AbortSignal.timeout(5000) });
  await response.arrayBuffer();
  // 409 = BucketAlreadyOwnedByYou, which is exactly what we want on a re-run.
  if (!response.ok && response.status !== 409) {
    throw new Error(`could not create bucket: HTTP ${response.status}`);
  }
}

const liveSkip = await (async () => {
  try {
    const probe = await fetch(new URL("/minio/health/live", LIVE.endpoint), {
      signal: AbortSignal.timeout(1500),
    });
    await probe.arrayBuffer();
  } catch {
    return `no S3-compatible server reachable at ${LIVE.endpoint}`;
  }
  try {
    await ensureBucket();
  } catch (error) {
    return `server reachable but bucket setup failed: ${error.message}`;
  }
  return false;
})();

test("round trip: put, head, get and delete a real object", { skip: liveSkip }, async () => {
  const client = createS3Client({ ...LIVE, forcePathStyle: true });
  const key = `round-trip/${Date.now()}/hello world+&'().png`;
  // Deliberately not valid UTF-8 text: this must survive as raw bytes.
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);

  const put = await client.putObject({
    key,
    body,
    contentType: "image/png",
    metadata: { mediaid: "med_roundtrip" },
  });
  assert.ok(put.etag, "put returned no ETag");

  const head = await client.headObject({ key });
  assert.equal(head.contentLength, body.length);
  assert.equal(head.contentType, "image/png");
  assert.equal(head.metadata.mediaid, "med_roundtrip");

  const got = await client.getObject({ key });
  assert.deepEqual(got.body, body, "bytes did not round trip");
  assert.equal(got.contentType, "image/png");
  assert.equal(got.metadata.mediaid, "med_roundtrip");

  await client.deleteObject({ key });

  const afterDelete = await client.headObject({ key }).then(() => null, (thrown) => thrown);
  assert.ok(afterDelete instanceof S3Error);
  assert.equal(isNotFound(afterDelete), true);
});

test("round trip: a missing key reports NoSuchKey from the server", { skip: liveSkip }, async () => {
  const client = createS3Client({ ...LIVE, forcePathStyle: true });
  const error = await client.getObject({ key: `absent/${Date.now()}.bin` })
    .then(() => null, (thrown) => thrown);

  assert.ok(error instanceof S3Error);
  assert.equal(error.statusCode, 404);
  assert.equal(error.code, "NoSuchKey", "the code must come from the server's XML body");
});

test("round trip: a wrong secret is rejected by the server, proving the signature is checked",
  { skip: liveSkip }, async () => {
    const client = createS3Client({
      ...LIVE,
      secretAccessKey: `${LIVE.secretAccessKey}-wrong`,
      forcePathStyle: true,
    });
    const error = await client.putObject({ key: "denied.txt", body: "x" })
      .then(() => null, (thrown) => thrown);

    assert.ok(error instanceof S3Error);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "SignatureDoesNotMatch");
  });
