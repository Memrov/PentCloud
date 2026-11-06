import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
export function matchingLock(pack,recipe,sdk){
  assert(isDeepStrictEqual(recipe,sdk),'Image recipe does not match the installed SDK lock: '+pack);
  assert(pack==='recon'||recipe.packId===pack,'Tool image recipe has another pack identity');
}
export function recipeIdentity(pack,lock,commit,regctlVersion){
  assert.match(commit,/^[a-f0-9]{40}$/);assert.match(pack,/^[a-z-]+$/);
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
  return createHash('sha256').update(JSON.stringify(canonical({pack,lock,commit,regctlVersion,goVersion:'go1.26.5',platform:'linux/amd64'}))).digest('hex');
}
export function releaseDigest(release){
  assert.match(release.digest??'',/^sha256:[a-f0-9]{64}$/,'Build returned an invalid immutable digest');
  assert.equal(release.platform,'linux/amd64','Build returned another platform');
  assert(Number.isSafeInteger(release.compressedBytes)&&release.compressedBytes>0,'Build returned no bounded image size');
  return release.digest;
}

