// Country tags of Open Food Facts (`countries_tags`) with their names, for the country choice of the catalogue.
// The list holds the usual ones; any other tag can still be entered as "other country".
const NAMES: [tag: string, de: string, en: string][] = [
  ['en:germany', 'Deutschland', 'Germany'], ['en:austria', 'Österreich', 'Austria'], ['en:switzerland', 'Schweiz', 'Switzerland'],
  ['en:france', 'Frankreich', 'France'], ['en:italy', 'Italien', 'Italy'], ['en:spain', 'Spanien', 'Spain'], ['en:portugal', 'Portugal', 'Portugal'],
  ['en:belgium', 'Belgien', 'Belgium'], ['en:netherlands', 'Niederlande', 'Netherlands'], ['en:luxembourg', 'Luxemburg', 'Luxembourg'],
  ['en:united-kingdom', 'Vereinigtes Königreich', 'United Kingdom'], ['en:ireland', 'Irland', 'Ireland'],
  ['en:denmark', 'Dänemark', 'Denmark'], ['en:sweden', 'Schweden', 'Sweden'], ['en:norway', 'Norwegen', 'Norway'], ['en:finland', 'Finnland', 'Finland'],
  ['en:iceland', 'Island', 'Iceland'], ['en:poland', 'Polen', 'Poland'], ['en:czech-republic', 'Tschechien', 'Czechia'], ['en:slovakia', 'Slowakei', 'Slovakia'],
  ['en:hungary', 'Ungarn', 'Hungary'], ['en:romania', 'Rumänien', 'Romania'], ['en:bulgaria', 'Bulgarien', 'Bulgaria'], ['en:greece', 'Griechenland', 'Greece'],
  ['en:croatia', 'Kroatien', 'Croatia'], ['en:slovenia', 'Slowenien', 'Slovenia'], ['en:serbia', 'Serbien', 'Serbia'], ['en:estonia', 'Estland', 'Estonia'],
  ['en:latvia', 'Lettland', 'Latvia'], ['en:lithuania', 'Litauen', 'Lithuania'], ['en:turkey', 'Türkei', 'Turkey'], ['en:ukraine', 'Ukraine', 'Ukraine'],
  ['en:united-states', 'USA', 'United States'], ['en:canada', 'Kanada', 'Canada'], ['en:mexico', 'Mexiko', 'Mexico'], ['en:brazil', 'Brasilien', 'Brazil'],
  ['en:argentina', 'Argentinien', 'Argentina'], ['en:chile', 'Chile', 'Chile'], ['en:colombia', 'Kolumbien', 'Colombia'],
  ['en:australia', 'Australien', 'Australia'], ['en:new-zealand', 'Neuseeland', 'New Zealand'], ['en:japan', 'Japan', 'Japan'],
  ['en:south-korea', 'Südkorea', 'South Korea'], ['en:china', 'China', 'China'], ['en:india', 'Indien', 'India'], ['en:thailand', 'Thailand', 'Thailand'],
  ['en:singapore', 'Singapur', 'Singapore'], ['en:israel', 'Israel', 'Israel'], ['en:united-arab-emirates', 'Vereinigte Arabische Emirate', 'United Arab Emirates'],
  ['en:south-africa', 'Südafrika', 'South Africa'], ['en:morocco', 'Marokko', 'Morocco'], ['en:tunisia', 'Tunesien', 'Tunisia'], ['en:egypt', 'Ägypten', 'Egypt'],
];

/** The name of a country tag in the given language; an unknown tag stays as it is. */
export function countryName(tag: string, lang: 'de' | 'en'): string {
  const hit = NAMES.find((n) => n[0] === tag);
  return hit ? hit[lang === 'de' ? 1 : 2] : tag;
}

/** The known countries, sorted by their name in the given language. */
export function countryOptions(lang: 'de' | 'en'): { tag: string; name: string }[] {
  return NAMES.map((n) => ({ tag: n[0], name: n[lang === 'de' ? 1 : 2] })).sort((a, b) => a.name.localeCompare(b.name, lang));
}
