#!/usr/bin/env node
// =============================================================================
// Build the installers, signed when the signing secrets exist (marinoscar/kvox#587)
// =============================================================================
//
//   node scripts/dist.mjs [electron-builder arguments...]
//
// electron-builder.yml holds everything but the signing identity. This script
// reads the environment, decides what can be signed, prints that decision as
// a notice (GitHub Actions `::notice::` lines, and the job summary when there
// is one) and runs electron-builder with the matching `-c.*` overrides. With
// no secret at all it builds unsigned installers, which is what CI on a pull
// request does on every runner.
//
//   Windows  Azure Trusted Signing when AZURE_SIGNING_ENDPOINT,
//            AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_CERT_PROFILE and
//            AZURE_SIGNING_PUBLISHER_NAME are set (the Azure login itself is
//            the workflow's `azure/login` step, by OIDC).
//   macOS    Developer ID when CSC_LINK (or CSC_NAME) is set; notarized when
//            APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are set too.
//            Otherwise `mac.identity=null`: no signing beyond the ad-hoc
//            signature the fuse step restores.
//   Linux    nothing here: the release workflow signs SHA256SUMS with GPG.
//
// The plan names variables, never their values: no secret reaches a log. It is
// also written to release/signing-<platform>-<arch>.json, which the release
// job reads to decide whether the release may be published
// (scripts/release-files.mjs gate).
// =============================================================================

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const AZURE_VARIABLES = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_CERT_PROFILE', 'AZURE_SIGNING_PUBLISHER_NAME'];
export const NOTARIZE_VARIABLES = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

const set = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';
const missing = (env, names) => names.filter((name) => !set(env, name));

/**
 * What can be signed with this environment, on this platform: the
 * electron-builder overrides, extra environment and one notice per decision.
 */
export function signingPlan(env, platform) {
  const args = [];
  const extraEnv = {};
  const notices = [];
  const plan = { windowsSigned: false, macSigned: false, macNotarized: false };

  if (platform === 'win32') {
    const absent = missing(env, AZURE_VARIABLES);
    if (absent.length === 0) {
      plan.windowsSigned = true;
      args.push(
        `-c.win.azureSignOptions.endpoint=${env.AZURE_SIGNING_ENDPOINT}`,
        `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_SIGNING_ACCOUNT}`,
        `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_SIGNING_CERT_PROFILE}`,
        `-c.win.azureSignOptions.publisherName=${env.AZURE_SIGNING_PUBLISHER_NAME}`,
      );
      notices.push('Windows: signing with Azure Trusted Signing');
    } else {
      notices.push(`Windows: NOT signed (${absent.join(', ')} not set): SmartScreen will warn`);
    }
  }

  if (platform === 'darwin') {
    if (set(env, 'CSC_LINK') || set(env, 'CSC_NAME')) {
      plan.macSigned = true;
      notices.push('macOS: signing with the Developer ID certificate (hardened runtime)');
      const absent = missing(env, NOTARIZE_VARIABLES);
      if (absent.length === 0) {
        plan.macNotarized = true;
        args.push('-c.mac.notarize=true');
        notices.push('macOS: notarizing with the App Store Connect API key');
      } else {
        args.push('-c.mac.notarize=false');
        notices.push(`macOS: NOT notarized (${absent.join(', ')} not set): Gatekeeper will block the app`);
      }
    } else {
      args.push('-c.mac.identity=null', '-c.mac.notarize=false');
      extraEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
      notices.push('macOS: NOT signed (CSC_LINK not set): ad-hoc signature only, Gatekeeper will block the app');
    }
  }

  if (platform === 'linux') {
    notices.push('Linux: the .deb and AppImage carry no code signature; the release signs SHA256SUMS with GPG when LINUX_GPG_PRIVATE_KEY is set');
  }

  return { args, env: extraEnv, notices, ...plan };
}

function report(notices) {
  for (const line of notices) {
    console.log(process.env.GITHUB_ACTIONS ? `::notice title=Signing::${line}` : `dist: ${line}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Signing (${process.platform})\n${notices.map((n) => `- ${n}`).join('\n')}\n`);
  }
}

/** The architectures an electron-builder command line builds (its own default: this machine's). */
export function archsOf(argv, fallback = process.arch) {
  const archs = ['x64', 'arm64', 'ia32', 'universal'].filter((arch) => argv.includes(`--${arch}`));
  return archs.length > 0 ? archs : [fallback];
}

function main(argv) {
  const plan = signingPlan(process.env, process.platform);
  report(plan.notices);
  const arch = archsOf(argv).join('+');
  const { windowsSigned, macSigned, macNotarized } = plan;
  mkdirSync(join(projectDir, 'release'), { recursive: true });
  writeFileSync(
    join(projectDir, 'release', `signing-${process.platform}-${arch}.json`),
    `${JSON.stringify({ platform: process.platform, arch, windowsSigned, macSigned, macNotarized, notices: plan.notices }, null, 2)}\n`,
  );
  const require = createRequire(join(projectDir, 'package.json'));
  const cli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, ...argv, ...plan.args], {
    cwd: projectDir,
    stdio: 'inherit',
    env: { ...process.env, ...plan.env },
  });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
