#!/usr/bin/env node
/**
 * `npx cap add android` generates a fresh Android project and will happily
 * overwrite MainActivity. This script re-applies our native layer afterwards,
 * so `npm run android:sync` is always safe to re-run.
 *
 * It does four things:
 *   1. copies the Kotlin sources into the right package directory
 *   2. deletes the generated Java MainActivity if present (ours is Kotlin)
 *   3. injects the <queries> block into AndroidManifest.xml, idempotently
 *   4. patches Gradle to compile Kotlin, since the Capacitor template is
 *      Java-only and silently ignores .kt files otherwise
 *
 * Every step is idempotent, which is what makes headless CI builds possible.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KOTLIN_VERSION = '1.9.24';

const APP_ID = JSON.parse(readFileSync('capacitor.config.json', 'utf8')).appId;
const pkgPath = APP_ID.split('.').join('/');
const javaRoot = join('android', 'app', 'src', 'main', 'java');
const target = join(javaRoot, pkgPath);
const manifestPath = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!existsSync('android')) {
  console.error('No android/ directory. Run `npm run android:init` first.');
  process.exit(1);
}

mkdirSync(target, { recursive: true });

for (const file of ['NostrSignerPlugin.kt', 'MainActivity.kt']) {
  const src = readFileSync(join('native', 'android', file), 'utf8').replace(
    /^package .*$/m,
    `package ${APP_ID}`
  );
  writeFileSync(join(target, file), src);
  console.log(`wrote ${join(target, file)}`);
}

// Capacitor scaffolds MainActivity.java. Two MainActivity classes in one
// package is a compile error, so the generated one has to go.
const stale = join(target, 'MainActivity.java');
if (existsSync(stale)) {
  rmSync(stale);
  console.log('removed generated MainActivity.java');
}

let manifest = readFileSync(manifestPath, 'utf8');

if (manifest.includes('android:scheme="nostrsigner"')) {
  console.log('manifest already has the nostrsigner queries block');
} else {
  const queries = readFileSync(join('native', 'android', 'AndroidManifest.queries.xml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  // Must be a sibling of <application>, not a child.
  manifest = manifest.replace('</manifest>', `\n${queries}\n</manifest>`);
  writeFileSync(manifestPath, manifest);
  console.log('injected <queries> into AndroidManifest.xml');
}

// -- Gradle: teach the Java-only template to compile Kotlin ----------------

const rootGradle = join('android', 'build.gradle');
let root = readFileSync(rootGradle, 'utf8');
if (root.includes('kotlin-gradle-plugin')) {
  console.log('root build.gradle already has the Kotlin plugin');
} else {
  // Insert alongside the existing Android Gradle Plugin classpath.
  const anchor = /(classpath\s+['"]com\.android\.tools\.build:gradle[^\n]*\n)/;
  if (!anchor.test(root)) {
    console.error('Could not find the AGP classpath line in android/build.gradle.');
    process.exit(1);
  }
  root = root.replace(
    anchor,
    `$1        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'\n`
  );
  writeFileSync(rootGradle, root);
  console.log('added kotlin-gradle-plugin to android/build.gradle');
}

const appGradle = join('android', 'app', 'build.gradle');
let app = readFileSync(appGradle, 'utf8');
if (app.includes("apply plugin: 'kotlin-android'")) {
  console.log('app build.gradle already applies kotlin-android');
} else {
  const anchor = /(apply plugin:\s*['"]com\.android\.application['"]\s*\n)/;
  if (!anchor.test(app)) {
    console.error('Could not find the application plugin line in android/app/build.gradle.');
    process.exit(1);
  }
  app = app.replace(anchor, `$1apply plugin: 'kotlin-android'\n`);
  writeFileSync(appGradle, app);
  console.log('applied kotlin-android in android/app/build.gradle');
}

const kotlinPlugin = readdirSync(target).filter((f) => f.endsWith('.kt'));
console.log(`\nnative layer ready: ${kotlinPlugin.join(', ')}`);
