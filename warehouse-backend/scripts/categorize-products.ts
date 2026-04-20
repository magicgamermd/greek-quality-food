/**
 * Standalone script to categorize all products.
 * Run: npx tsx scripts/categorize-products.ts
 *
 * This applies the same keyword logic as migration 021
 * but can be re-run at any time to re-categorize new products.
 */
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

interface CategoryRule {
  id: number;
  name_bg: string;
  name_en: string;
  /** Keywords that INCLUDE a product in this category (case-insensitive, matched against name_bg) */
  include: string[];
  /** Keywords that EXCLUDE a product even if include matches */
  exclude?: string[];
}

const CATEGORIES: CategoryRule[] = [
  {
    id: 1,
    name_bg: "Зехтин и Маслини",
    name_en: "Olive Oil & Olives",
    include: [
      "зехтин", "маслин", "маслинов", "olive", "критамос", "каперси",
      "салатно олио", "слънчогледово олио", "маслиново масло", "помпа за зехтин",
    ],
    exclude: ["паста", "торта", "кейк"],
  },
  {
    id: 2,
    name_bg: "Паста и Тестени Продукти",
    name_en: "Pasta & Dough Products",
    include: [
      "спагети", "спагетини", "макарони", "пенне", "фиде", "юфка",
      "талиатели", "лингуини", "критараки", "фусили", "кус кус", "трахана",
      "булгур", "кори за", "ориз ", "леща", "нахут", "фава ", "евристо",
      "жито белено", "осприада", "ospriada", "брашно", "грис ",
      "бакпулвер", "пудра захар", "захар ", "сода за готвене",
      "кувертюр", "какао ", "ванилин", "ванилия пръчка",
      "кондензирано мляко", "бешамел", "бульон",
      "доматено пюре", "домати белени", "домати смляни", "pummaro", "passata",
      "лозови листа", "лозови сърми",
      "горчиза", "горчица", "кетчуп", "майонеза", "сос от горчица",
      "оцет", "балсам", "мармалад", "сладко папа", "мед от",
      "крем мед", "меренда ", "сушен домат", "сушени домати",
      "печен патладжан", "туршия", "кисели краставички",
      "пикантно марин", "червено цвекло", "царевица сладка",
      "гъби нарязани", "боб гигант", "боб червен", "боб черно око",
      "боб едър", "боб нормален", "боб със", "боб -", "зелен боб",
      "леща със", "супа от нахут", "супа с гъби",
      "стафида", "сол морска", "морска сол", "хималайска сол",
      "черна индийска", "карамелизиран лук", "салца", "песто",
      "желе ", "лукумадес", "локум", "бяло сладко",
      // Подправки
      "риган", "босилек", "канела ", "черен пипер", "бял пипер",
      "розов пипер", "микс пипер", "микс 4 пипера",
      "червен пипер", "кимион", "къри", "кориандър",
      "коркума", "куркума", "карамфил", "кардамон", "бахар",
      "анасон", "дафинов лист", "джинджифил", "джоджен",
      "мащерка", "розмаранин", "майорана", "луиза",
      "сусам", "шафран", "мастиха хиос", "махлепи",
      "индийско орехче", "сумак", "кедрови ядки", "микс за",
      "подправка", "чесън ", "градински чай", "салепи",
      "морсалски чай", "боя за яйца",
      "зеленчуци спирала", "царевично брашно", "лимонов сок",
      "скилидки чесън", "chili peppers", "hot chillis",
      "камби pepelicious", "чушки македония", "чушки ",
    ],
    exclude: [
      "маслинова паста", "каламата паста", "паста делукс", "паста флора",
      "триъгълна паста", "грис халва", "мляко с какао",
      "без захар", "канела и захар", "наденица с риган",
      "филе с риган", "печен с риган", "пушено филе с риган",
      "скилидки", "ципуро", "мед от мащерка", "сирене с мащерка",
      "наденица с", "салам с", "чушки пълнени",
    ],
  },
  {
    id: 3,
    name_bg: "Халва и Тахан",
    name_en: "Halva & Tahini",
    include: [
      "халва", "halva", "тахан", "tachini", "sisinni",
      "фастъчено масло", "сусамов тахан",
      "вафлички с таханов", "вафлички с фъстъчен", "сусамови блокчета",
    ],
  },
  {
    id: 4,
    name_bg: "Сирена и Млечни Продукти",
    name_en: "Cheese & Dairy Products",
    include: [
      "сирене", "сирена", "фета", "гравиера", "graviera", "кашери",
      "кашкавал", "кефалотири", "халуми", "манури", "антотиро",
      "мизитра", "мецовоне", "ладотири", "мелихлоро", "пекорино",
      "талагани", "саганаки", "гауда", "кисело мляко", "козе мляко",
      "краве мляко", "цедено", "айрян", "кефир", "крема сирене",
      "козе сирене", "краве сирене", "козе elason", "краве масло",
      "овче-козе масло", "млечна сметана", "цеден десерт",
      "мляко с какао", "мляко с ориз", "постно сирене", "аневато",
    ],
    exclude: [
      "баница", "бутер", "туистър", "бисквити", "пица", "пенерли",
    ],
  },
  {
    id: 5,
    name_bg: "Колбаси",
    name_en: "Deli Meats & Sausages",
    include: [
      "наденица", "наденички", "салам", "колбас", "пастърма",
      "pastrami", "пастрами", "прошуто", "prosciutto", "мортадела",
      "паризаки", "шунка", "суджук", "кюрмузур", "сиглино",
      "овча пастърма", "пуешко филе", "mouchteron", "pork grilled",
      "beef pastrami", "le grand beef",
      "ΛΟΥΚΑΝΙΚΟ", "ΜΠΡΙΖΟΛΑ", "ΠΡΟΣΟΥΤΟ", "ΣΑΛΑΜΙ", "λΟΥΚΑΝΙΚΟ",
      // Салати и мезета
      "салата ", "хайвер", "мезе за узо", "микс за узо", "неразбит хайвер",
      // Риба
      "сардина", "сардини", "риба тон", "калмари", "октопод",
      "аншоа", "бакалиаро", "скумрия", "филе от гаврос", "филе от гаврус",
      "чируз", "тонолакерда", "филе от риба", "mixed salad",
      // Свинско/Телешко месо
      "свинск", "телешк",
    ],
    exclude: [
      "баница", "гнездо с колбаси", "пица", "пенерли", "сладък салам",
    ],
  },
  {
    id: 6,
    name_bg: "Печива",
    name_en: "Baked Goods & Pastries",
    include: [
      "баница", "бугаца", "bougatsa", "кроасан", "croissant", "cornrtti",
      "геврек", "bread ring", "bread stick", "багета", "baguette",
      "хляб", "панини", "пица", "pizzarto", "пенерли", "пейнирли",
      "peinirli", "бриош", "донът", "donut", "поничка",
      "мъфин", "muffin", "бюрек", "пай с пиле", "strudel",
      "puff pastri", "ring with turkey", "sausage pie", "stick with potato",
      "handmade pie", "traditional pie", "triangle pie",
      "multigrain bakery", "козунак", "tsoureki", "панетоне",
      "кукис", "cookie", "бисквит", "сухар", "бейгъл", "bagel",
      "калцоне", "бутер баница", "бутер пай", "туистър",
      "катепсигмени", "frozen baguette", "солунски геврек",
      "гнездо с колбаси",
    ],
    exclude: [
      "хрупкав геврек", "пълнозърнест хрупкав", "многозърнест хрупкав",
      "кейк", "торта", "десерт", "шоколад бисквит", "орехови кукис",
    ],
  },
  {
    id: 7,
    name_bg: "Сладки и Соленки",
    name_en: "Sweets & Salty Snacks",
    include: [
      "торта", "cake", "кейк", "десерт", "dessert", "тирамису", "tiramisu",
      "профитерол", "profiterol", "еклер", "eclair", "мил фей",
      "mille feuille", "чийзкейк", "cheesecake", "суфле", "souffle",
      "екмек", "ekmek", "баклава", "baklava", "сиропиран", "кадаифчета",
      "казан диби", "каридопита", "лемонопита", "портокалопита",
      "шоколатопита", "галактобуреко", "толумби", "толумбички",
      "финикаки", "куркубиня", "самали", "сарагли", "роксаки",
      "реване", "пръстчета", "тригуни", "меломакарона", "курабии",
      "чашки ", "паста делукс", "паста флора", "тарталета", "тарт ",
      "гнездо с крем", "гнездо с шоколад", "гнездо с орехов",
      "шоколад", "шок. бонбони", "шокофрета", "golden choco",
      "golden handmade", "chocolate pop", "ion ", "lacta ",
      "млечен шоколад лакта", "caprise",
      "хлебни пръчици", "хрупкав геврек", "хрупкави пръчици",
      "многозърнест хрупкав", "пълнозърнест хрупкав",
      "брецел", "топчета със сирене", "солени бисквити", "батонсале",
      "heart -", "галета", "protein bar", "енергиен бар",
      "БИО Овесено", "карамелизирани бисквити",
      "мусака", "moussaka", "пастицио", "pastitsio", "имам", "imam",
      "бриам", "briam", "домати и зелени чушки", "gemista",
      "спанак с ориз", "spanakorizo", "пиле с ориз",
      "телешко месо с грах", "кюфтета", "soutzoukakia",
      "селска наденица със зеленчуци", "spetsofai",
      "lahanodolmades", "kolokithakia", "пълнени чушки",
      "karamela", "орехови кукис", "милфьой",
      "американски бисквитки", "кокосова бисквитка", "лимонов пай",
      "mini tart", "mixed cake", "kok 170", "мини kok",
      "мини negraki", "мини truffle", "мини торта", "sugar angel",
      "elevated", "premium chocolate", "триъгълна паста",
      "квадратна торта", "кръгла торта", "триъгълник от солун",
      "великденски шоколад", "коледен кейк", "коледен козунак",
      "коледна", "новогодишна торта", "василопита", "петифури",
      "портокалови резенчета", "шоколадови пурички", "шоколадов тарт",
      "саварин", "сладък салам", "солен карамел",
      "стъклено бурканче", "чаша профитерол", "чаша фереро",
      "nini mosaic", "bueno in bowl", "speculoos", "lava banana",
      "морков торта", "рафаело на тава", "червено кадифе на тава",
      "тираису на тава", "ябълков пай", "apple pie", "mango yogurt",
      "pantelka", "laurence", "pre-packed stand",
      "ванилови мъфини", "шоколадов мъфин", "брауни", "brownie",
      "walnut brownie", "роза ",
    ],
    exclude: [
      "мъфин", "кроасан", "донът", "поничка", "козунак",
      "баница с шоколад", "сладко роза", "bread ring",
    ],
  },
  {
    id: 8,
    name_bg: "Сладолед",
    name_en: "Ice Cream",
    include: [
      "сладолед", "ice cream", "сорбе", "kaimaki", "каимаки", "planet ",
    ],
  },
  {
    id: 9,
    name_bg: "Безалкохолни Напитки и Вода",
    name_en: "Soft Drinks & Water",
    include: [
      "вода", "бода ", "coca cola", "лимонада", "lemonade",
      "оранжада", "orangeade", "gazoze", "rossolis", "сода mr",
      "epsa ", "сок от", "енергийна напитка", "безалкохолн",
      "чай ", "ЧАЙ ", "кафе", "нес кафе", "гръцко кафе",
    ],
    exclude: ["градински чай", "морсалски чай"],
  },
  {
    id: 10,
    name_bg: "Узо, Ципуро и Вино",
    name_en: "Ouzo, Tsipouro & Wine",
    include: [
      "узо", "ципуро", "вино", "рецина", "beer", "бира", "vergina",
      "liquer", "evropale",
    ],
    exclude: ["свинско", "празна бутилка"],
  },
];

function categorizeProduct(
  name: string,
): { categoryId: number; categoryName: string } | null {
  const lower = name.toLowerCase();

  for (const cat of CATEGORIES) {
    const matchesInclude = cat.include.some((kw) =>
      lower.includes(kw.toLowerCase()),
    );
    if (!matchesInclude) continue;

    const matchesExclude = cat.exclude
      ? cat.exclude.some((kw) => lower.includes(kw.toLowerCase()))
      : false;
    if (matchesExclude) continue;

    return { categoryId: cat.id, categoryName: cat.name_bg };
  }

  return null;
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();
  console.log("Connected to PostgreSQL\n");

  // Ensure categories exist
  for (const cat of CATEGORIES) {
    await client.query(
      `INSERT INTO categories (id, name_bg, name_en)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name_bg = $2, name_en = $3`,
      [cat.id, cat.name_bg, cat.name_en],
    );
  }
  console.log(`✓ ${CATEGORIES.length} categories ensured\n`);

  // Get all products
  const { rows: products } = await client.query(
    "SELECT id, name_bg, category_id FROM products ORDER BY name_bg",
  );

  let updated = 0;
  let skipped = 0;
  const uncategorized: string[] = [];
  const counts: Record<string, number> = {};

  for (const p of products) {
    const result = categorizeProduct(p.name_bg);
    if (result) {
      if (p.category_id !== result.categoryId) {
        await client.query("UPDATE products SET category_id = $1 WHERE id = $2", [
          result.categoryId,
          p.id,
        ]);
        updated++;
      } else {
        skipped++;
      }
      counts[result.categoryName] = (counts[result.categoryName] || 0) + 1;
    } else {
      uncategorized.push(p.name_bg);
    }
  }

  console.log("=== Category Distribution ===");
  for (const cat of CATEGORIES) {
    console.log(`  ${cat.name_bg}: ${counts[cat.name_bg] || 0}`);
  }

  console.log(`\n✓ Updated: ${updated}`);
  console.log(`  Skipped (already correct): ${skipped}`);
  console.log(`  Uncategorized: ${uncategorized.length}`);

  if (uncategorized.length > 0) {
    console.log("\n=== Uncategorized Products ===");
    uncategorized.forEach((name) => console.log(`  - ${name}`));
  }

  await client.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
