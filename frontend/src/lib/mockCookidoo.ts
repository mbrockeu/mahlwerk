// Invented Cookidoo data for the mock and the demo: several collections with 7 to 30 recipes each (names in German and English, values
// per portion made up from the position in the list, so they are always the same). A few recipes have no values ("no_nutrition") or
// fail, so that the take-over run has something to report. Nothing here is real and nothing leaves the page.
import type { Per100 } from './types';

export interface MockCookidooRecipe { id: string; name: string; portions: number; per: Per100 | null; fails: boolean }
export interface MockCookidooCollection { id: string; name: string; managed: boolean; recipes: { id: string; name: string }[] }

type Names = [string, string][]; // [German, English]
const QUICK: Names = [
  ['Pfannen-Gnocchi mit Spinat', 'Skillet gnocchi with spinach'], ['Hähnchen-Curry mit Reis', 'Chicken curry with rice'], ['Gemüse-Wok mit Nudeln', 'Vegetable wok with noodles'],
  ['Lachs mit Ofengemüse', 'Salmon with roasted vegetables'], ['Kichererbsen-Pfanne', 'Chickpea skillet'], ['Tortilla-Auflauf', 'Tortilla bake'], ['Kartoffel-Frittata', 'Potato frittata'],
  ['Zucchini-Nudeln mit Pesto', 'Zucchini noodles with pesto'], ['Shakshuka', 'Shakshuka'], ['Linsen-Dal mit Kokos', 'Coconut lentil dal'], ['Käsespätzle', 'Cheese spaetzle'], ['Thunfisch-Pasta', 'Tuna pasta'],
];
const BAKING: Names = [
  ['Bananenbrot', 'Banana bread'], ['Zitronenkuchen', 'Lemon cake'], ['Karottenkuchen', 'Carrot cake'], ['Marmorkuchen', 'Marble cake'], ['Käsekuchen', 'Cheesecake'], ['Haferflocken-Kekse', 'Oat cookies'],
  ['Schoko-Muffins', 'Chocolate muffins'], ['Hefezopf', 'Braided yeast bread'], ['Quarkbrötchen', 'Quark rolls'], ['Dinkelbrot', 'Spelt bread'], ['Roggenmischbrot', 'Rye bread'], ['Apfelstrudel', 'Apple strudel'],
  ['Streuselkuchen', 'Crumb cake'], ['Zimtschnecken', 'Cinnamon rolls'], ['Focaccia mit Rosmarin', 'Rosemary focaccia'], ['Mohnkuchen', 'Poppy seed cake'], ['Rührkuchen', 'Pound cake'],
];
const SOUPS: Names = [
  ['Tomatensuppe', 'Tomato soup'], ['Karotten-Ingwer-Suppe', 'Carrot and ginger soup'], ['Kartoffelsuppe', 'Potato soup'], ['Linsensuppe', 'Lentil soup'], ['Erbseneintopf', 'Pea stew'], ['Gulaschsuppe', 'Goulash soup'],
  ['Hühnersuppe', 'Chicken soup'], ['Brokkoli-Cremesuppe', 'Cream of broccoli soup'], ['Zwiebelsuppe', 'Onion soup'], ['Minestrone', 'Minestrone'], ['Chili sin Carne', 'Chili sin carne'], ['Maissuppe', 'Corn chowder'],
  ['Kokos-Curry-Suppe', 'Coconut curry soup'], ['Bohneneintopf', 'Bean stew'], ['Pilzcremesuppe', 'Cream of mushroom soup'], ['Rote-Bete-Suppe', 'Beetroot soup'], ['Spargelcremesuppe', 'Cream of asparagus soup'],
  ['Süßkartoffelsuppe', 'Sweet potato soup'], ['Graupeneintopf', 'Barley stew'], ['Fischsuppe', 'Fish soup'], ['Gemüseeintopf', 'Vegetable stew'], ['Kohlrabisuppe', 'Kohlrabi soup'],
];
const PREP: Names = [
  ['Overnight Oats mit Beeren', 'Overnight oats with berries'], ['Quinoa-Bowl', 'Quinoa bowl'], ['Reis-Gemüse-Boxen', 'Rice and vegetable boxes'], ['Hähnchen-Bowl', 'Chicken bowl'], ['Protein-Pancakes', 'Protein pancakes'],
  ['Hummus', 'Hummus'], ['Energy Balls', 'Energy balls'], ['Gemüse-Muffins', 'Vegetable muffins'], ['Bolognese-Basis', 'Bolognese base'],
];
const BREAKFAST: Names = [
  ['Porridge mit Apfel', 'Apple porridge'], ['Joghurt-Bowl', 'Yogurt bowl'], ['Rührei mit Kräutern', 'Scrambled eggs with herbs'], ['Avocado-Toast', 'Avocado toast'], ['Selbstgemachtes Müsli', 'Homemade muesli'],
  ['Pfannkuchen', 'Pancakes'], ['Beeren-Smoothie', 'Berry smoothie'],
];
const XMAS: Names = [
  ['Vanillekipferl', 'Vanilla crescents'], ['Zimtsterne', 'Cinnamon stars'], ['Spitzbuben', 'Jam sandwich cookies'], ['Butterplätzchen', 'Butter cookies'], ['Lebkuchen', 'Gingerbread'], ['Dominosteine', 'Domino bites'],
  ['Christstollen', 'Christmas stollen'], ['Marzipankartoffeln', 'Marzipan potatoes'], ['Kokosmakronen', 'Coconut macaroons'], ['Haselnussmakronen', 'Hazelnut macaroons'], ['Printen', 'Spiced biscuits'],
  ['Pfeffernüsse', 'Pepper nuts'], ['Spekulatius', 'Speculoos'], ['Heidesand', 'Heath sand cookies'], ['Husarenkrapfen', 'Hussar buns'], ['Nussecken', 'Nut corners'], ['Linzer Plätzchen', 'Linzer cookies'],
  ['Anisplätzchen', 'Aniseed drops'], ['Orangen-Schoko-Kekse', 'Orange chocolate cookies'], ['Mandelhörnchen', 'Almond crescents'], ['Florentiner', 'Florentines'], ['Rumkugeln', 'Rum balls'],
  ['Bratapfel-Kuchen', 'Baked apple cake'], ['Glühwein-Kuchen', 'Mulled wine cake'], ['Schokoladentrüffel', 'Chocolate truffles'], ['Zimtmandeln', 'Cinnamon almonds'], ['Walnusstaler', 'Walnut rounds'],
  ['Ingwerkekse', 'Ginger cookies'], ['Schwarz-Weiß-Gebäck', 'Black and white cookies'], ['Kokosbusserl', 'Coconut kisses'],
];

export function buildCookidoo(L: (de: string, en: string) => string) {
  const recipes = new Map<string, MockCookidooRecipe>();
  let n = 0;
  const make = (names: Names, base: number): { id: string; name: string }[] => names.map(([de, en]) => {
    n++;
    const id = `r${base + n}`;
    const kcal = 140 + ((n * 97) % 520);
    const protein = Math.round((4 + ((n * 7) % 30)) * 10) / 10;
    const fat = Math.round((3 + ((n * 5) % 28)) * 10) / 10;
    const carbs = Math.round(((kcal - protein * 4 - fat * 9) / 4) * 10) / 10;
    const noValues = n % 23 === 0;
    recipes.set(id, {
      id, name: L(de, en), portions: [1, 2, 4, 4, 6, 8, 12, 16][n % 8], fails: n % 41 === 0,
      per: noValues ? null : { kcal, fat, saturated_fat: Math.round(fat * 0.35 * 10) / 10, carbs: Math.max(carbs, 2), sugars: Math.round(carbs * 0.25 * 10) / 10, fiber: 2 + (n % 6), protein, salt: Math.round((0.3 + (n % 9) / 10) * 10) / 10 },
    });
    return { id, name: L(de, en) };
  });
  const lentil = { id: 'r100001', name: L('Linsensalat mit Feta', 'Lentil salad with feta') };
  const pumpkin = { id: 'r100002', name: L('Kürbissuppe', 'Pumpkin soup') };
  const cake = { id: 'r100003', name: L('Apfelkuchen vom Blech', 'Apple sheet cake') };
  const collections: MockCookidooCollection[] = [
    { id: 'c1', name: L('Schnelle Abendessen', 'Quick dinners'), managed: false, recipes: [pumpkin, lentil, ...make(QUICK, 200000)] },
    { id: 'c2', name: L('Backen', 'Baking'), managed: false, recipes: [cake, ...make(BAKING, 210000)] },
    { id: 'c3', name: L('Suppen & Eintöpfe', 'Soups & stews'), managed: true, recipes: [pumpkin, ...make(SOUPS, 220000)] },
    { id: 'c4', name: L('Meal Prep', 'Meal prep'), managed: false, recipes: make(PREP, 230000) },
    { id: 'c5', name: L('Frühstück', 'Breakfast'), managed: true, recipes: make(BREAKFAST, 240000) },
    { id: 'c6', name: L('Weihnachtsbäckerei', 'Christmas baking'), managed: true, recipes: make(XMAS, 250000) },
  ];
  const week = [
    { day: 'd1', title: L('Montag', 'Monday'), recipes: [lentil] },
    { day: 'd2', title: L('Dienstag', 'Tuesday'), recipes: [] },
    { day: 'd3', title: L('Mittwoch', 'Wednesday'), recipes: [pumpkin, collections[0].recipes[3]] },
    { day: 'd4', title: L('Donnerstag', 'Thursday'), recipes: [collections[3].recipes[1]] },
  ];
  return { recipes, collections, week, known: { r100001: { name: lentil.name, portions: 4, per: { kcal: 497, fat: 8, saturated_fat: 5, carbs: 73, sugars: 0, fiber: 12.2, protein: 37, salt: 2.9 } as Per100 },
    r100002: { name: pumpkin.name, portions: 4, per: { kcal: 180, fat: 9, saturated_fat: 3, carbs: 18, sugars: 0, fiber: 4, protein: 4, salt: 1.6 } as Per100 },
    r100003: { name: cake.name, portions: 16, per: { kcal: 265, fat: 11, saturated_fat: 6, carbs: 36, sugars: 0, fiber: 2, protein: 4, salt: 0.2 } as Per100 } } };
}
