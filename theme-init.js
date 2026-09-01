// Early theme application — loaded before main scripts to prevent flash of wrong theme.
(async()=>{try{const r=await chrome.storage.sync.get('sharpeTheme');
if(r.sharpeTheme==='light')document.documentElement.dataset.theme='light';
else if(!r.sharpeTheme&&matchMedia('(prefers-color-scheme:light)').matches)document.documentElement.dataset.theme='light';
}catch(e){}})();
