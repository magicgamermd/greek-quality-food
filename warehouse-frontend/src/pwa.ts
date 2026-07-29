import { registerSW } from "virtual:pwa-register";

// Кога е билднат кодът, който тече в момента. При съмнение „качено ли е
// при мен" се вижда в конзолата на браузъра и в `window.__GQF_BUILD__`.
declare const __BUILD_TIME__: string;
(window as unknown as Record<string, unknown>).__GQF_BUILD__ = __BUILD_TIME__;
console.info(`[GQF] версия на кода: ${__BUILD_TIME__}`);

// При нов деплой service worker-ът си сваля новите файлове наум, но вече
// отвореният прозорец продължава да върти СТАРИЯ код. Отвън изглежда, че
// поправката „не е качена", макар да е. В инсталираното PWA (от иконата)
// няма и как да се направи hard refresh — там прозорецът може да остане
// на стара версия дни наред.
//
// Затова: щом новият service worker поеме контрола, презареждаме веднъж
// сами.
//
// `hadController` пази първото посещение. Тогава service worker-ът се
// инсталира за пръв път и `controllerchange` пак се задейства, но няма
// стар код за подменяне — презареждане там е излишно мигане.
// `reloading` пази от цикъл, ако събитието дойде повече от веднъж.
const swContainer =
  typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
const hadController = !!swContainer?.controller;
let reloading = false;

swContainer?.addEventListener("controllerchange", () => {
  if (!hadController || reloading) return;
  reloading = true;
  window.location.reload();
});

// Складът държи таба отворен по цял ден. Без периодична проверка новата
// версия се хваща чак при следващото пълно отваряне — тоест на другия ден.
const UPDATE_CHECK_MS = 30 * 60 * 1000;

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    setInterval(() => void registration.update(), UPDATE_CHECK_MS);
  },
});
