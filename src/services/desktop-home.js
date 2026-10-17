import fs from 'node:fs';
import path from 'node:path';

// Managed desktop furniture; browser profiles and user-created files are kept.
export function prepareDesktopHome(home, browser) {
  const desktop=path.join(home,'Desktop');
  const config=path.join(home,'.config','pcmanfm','better-bots');
  fs.mkdirSync(desktop,{recursive:true});fs.mkdirSync(config,{recursive:true});
  const fileManagerConfig=path.join(home,'.config','libfm');
  fs.mkdirSync(fileManagerConfig,{recursive:true});
  // This is an app desktop: executable launchers should open their application.
  fs.writeFileSync(path.join(fileManagerConfig,'libfm.conf'),'[config]\nquick_exec=1\nterminal=xterm -e %s\n');
  fs.mkdirSync(path.join(home,'browser-profile'),{recursive:true});
  const preferences=path.join(home,'browser-profile','user.js');
  const existing=fs.existsSync(preferences)?fs.readFileSync(preferences,'utf8'):'';
  if(!existing.includes('// Better Bots desktop startup')) fs.writeFileSync(preferences,existing+'\n// Better Bots desktop startup\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n');
  const quote=value=>'"'+value.replace(/[\\"`$]/g,'\\$&')+'"';
  const launchers=[
    ['Browser','firefox',`${quote(browser)} --no-remote --profile ${quote(path.join(home,'browser-profile'))} about:blank`],
    ['Files','folder','pcmanfm --profile=better-bots /work'],
  ];
  for(const [name,icon,command] of launchers) fs.writeFileSync(path.join(desktop,`BetterBots-${name}.desktop`),`[Desktop Entry]\nType=Application\nName=${name}\nIcon=${icon}\nExec=${command}\nTerminal=false\n`,{mode:0o755});
  // No terminal on the desktop: shell commands go through the sandboxed shell
  // tool, which has no network. Remove the launcher earlier desktops were given.
  fs.rmSync(path.join(desktop,'BetterBots-Terminal.desktop'),{force:true});
  fs.writeFileSync(path.join(config,'desktop-items-0.conf'),'[*]\nwallpaper_mode=color\nwallpaper_common=1\nwallpaper=\ndesktop_bg=#20242d\ndesktop_fg=#ffffff\ndesktop_shadow=#20242d\nshow_documents=0\nshow_trash=0\nshow_mounts=0\n');
  // Explicitly locate desktop icons; no dependency on an interactive first login.
  fs.writeFileSync(path.join(home,'.config','user-dirs.dirs'),`XDG_DESKTOP_DIR=${quote(desktop)}\n`);
}
