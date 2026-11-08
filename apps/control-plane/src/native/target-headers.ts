/** Operator identity is never part of a target request. Target API keys are explicit. */
export function operatorIdentityHeader(name: string): boolean {
  return (
    /^(?:cf-|x-forwarded-|sec-|proxy-)/i.test(name) ||
    /^(?:authorization|cookie|origin|referer|forwarded|x-real-ip|true-client-ip|x-client-ip|x-cluster-client-ip|x-originating-ip|x-remote-ip|x-remote-addr|remote-addr|via)$/i.test(
      name
    )
  );
}

export function targetHeaders(
  initial?: HeadersInit,
  credential?: { header: string; value: string }
): Headers {
  const headers = new Headers(initial);
  const removed: string[] = [];
  headers.forEach((_value, name) => {
    if (operatorIdentityHeader(name)) removed.push(name);
  });
  for (const name of removed) headers.delete(name);
  if (credential) {
    if (
      operatorIdentityHeader(credential.header) &&
      credential.header.toLowerCase() !== "authorization"
    )
      throw new Error(
        "400: Operator identity headers cannot be used as target API credentials"
      );
    headers.set(credential.header, credential.value);
  }
  return headers;
}
