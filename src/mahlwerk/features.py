"""Switches and settings an admin can change at runtime (table `setting`), each with an optional environment override.

An environment variable wins over the stored value; the admin area then shows the setting as fixed by the environment.
"""

import os

TRUE = ("1", "true", "yes", "on")
FALSE = ("0", "false", "no", "off")
DEFAULT_COUNTRIES = ["en:germany"]

# setting key -> (environment variable, kind)
ENV = {
    "access_tokens.enabled": ("MAHLWERK_TOKENS", "bool"),
    "webhooks.enabled": ("MAHLWERK_WEBHOOKS", "bool"),
    "webhooks.hosts": ("MAHLWERK_WEBHOOK_HOSTS", "list"),
    "openfoodfacts_lookup.enabled": ("MAHLWERK_OFF_LOOKUP", "bool"),
    "openfoodfacts_catalog.countries": ("MAHLWERK_OFF_COUNTRIES", "list"),
    "cookidoo.enabled": ("MAHLWERK_COOKIDOO", "bool"),
    "web_recipes.enabled": ("MAHLWERK_WEB_RECIPES", "bool"),
    "cookidoo.personal": ("MAHLWERK_COOKIDOO_PERSONAL", "bool"),
    "cookidoo.images": ("MAHLWERK_COOKIDOO_IMAGES", "bool"),
    "web_recipes.images": ("MAHLWERK_WEB_RECIPES_IMAGES", "bool"),
    "yazio_login.enabled": ("MAHLWERK_YAZIO_LOGIN", "bool"),
    "demo_account.enabled": ("MAHLWERK_DEMO_ACCOUNT", "bool"),
}
DEFAULTS = {
    "access_tokens.enabled": True,
    "webhooks.enabled": True,
    "webhooks.hosts": [],
    "openfoodfacts_lookup.enabled": True,
    "openfoodfacts_catalog.countries": DEFAULT_COUNTRIES,
    "cookidoo.enabled": False,
    "web_recipes.enabled": False,  # off until an admin switches it on: the server then opens connections to pages people name
    "cookidoo.images": False,  # recipe pictures of Cookidoo are stored on this server only when an admin says so (they belong to the provider)
    "web_recipes.images": False,  # the same for the picture a recipe page names
    "cookidoo.personal": True,  # people may add an own Cookidoo account (the admin can forbid it)
    "yazio_login.enabled": False,  # the direct one-time Yazio sign-in is off until an admin switches it on
    "demo_account.enabled": False,  # the built-in demo account (admins may switch to it) is off until an admin switches it on
}


class Features:
    def __init__(self, store):
        self.store = store

    def _env(self, key: str):
        """The value the environment fixes for `key`, or None when it leaves the setting to the admin."""
        name, kind = ENV[key]
        raw = os.environ.get(name, "").strip()
        if not raw:
            return None
        if kind == "bool":
            lowered = raw.lower()
            return True if lowered in TRUE else False if lowered in FALSE else None
        return [part.strip() for part in raw.split(",") if part.strip()]

    def locked(self, key: str) -> bool:
        return self._env(key) is not None

    def get(self, key: str):
        fixed = self._env(key)
        if fixed is not None:
            return fixed
        return self.store.get_global(key, DEFAULTS[key])

    @property
    def tokens(self) -> bool:
        return bool(self.get("access_tokens.enabled"))

    @property
    def webhooks(self) -> bool:
        return bool(self.get("webhooks.enabled"))

    @property
    def cookidoo(self) -> bool:
        return bool(self.get("cookidoo.enabled"))

    @property
    def web_recipes(self) -> bool:
        return bool(self.get("web_recipes.enabled"))

    @property
    def cookidoo_images(self) -> bool:
        return bool(self.get("cookidoo.images"))

    @property
    def web_images(self) -> bool:
        return bool(self.get("web_recipes.images"))

    @property
    def cookidoo_personal(self) -> bool:
        return bool(self.get("cookidoo.personal"))

    @property
    def yazio_login(self) -> bool:
        return bool(self.get("yazio_login.enabled"))

    @property
    def demo_account(self) -> bool:
        return bool(self.get("demo_account.enabled"))

    @property
    def lookup(self) -> bool:
        return bool(self.get("openfoodfacts_lookup.enabled"))

    @property
    def webhook_hosts(self) -> list[str]:
        return [h.lower() for h in self.get("webhooks.hosts")]

    @property
    def countries(self) -> list[str]:
        return self.get("openfoodfacts_catalog.countries") or DEFAULT_COUNTRIES

    def host_allowed(self, host: str | None) -> bool:
        hosts = self.webhook_hosts
        return not hosts or (host or "").lower() in hosts

    def host_listed(self, host: str | None) -> bool:
        """The admin named this host: it may then be an internal one (a conscious decision)."""
        return bool(host) and host.lower() in self.webhook_hosts
