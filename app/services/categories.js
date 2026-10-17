const fs = require('fs');
const path = require('path');

const SKINS_DIR = path.join(__dirname, '..', '..', '..', 'public', 'images', 'weapons-real', 'skins');

function getCategories() {
    try {
        const entries = fs.readdirSync(SKINS_DIR, { withFileTypes: true });
        const folders = entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort();

        return folders.map((name, index) => ({
            id: index + 1,
            value: name,
        }));
    } catch (err) {
        return [];
    }
}

function getSubcategories(categoryValue) {
    try {
        const categoryPath = path.join(SKINS_DIR, categoryValue);
        return fs.readdirSync(categoryPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort()
            .filter(name => getImagesForSubcategory(categoryValue, name).length > 0);
    } catch (err) {
        return [];
    }
}

function getImagesForSubcategory(categoryValue, subcategoryValue) {
    try {
        const subcategoryPath = path.join(SKINS_DIR, categoryValue, subcategoryValue);
        return fs.readdirSync(subcategoryPath, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
            .map(entry => `/images/weapons-real/skins/${categoryValue}/${subcategoryValue}/${entry.name}`)
            .sort();
    } catch (err) {
        return [];
    }
}

function getImagesForCategory(categoryValue) {
    try {
        const categoryPath = path.join(SKINS_DIR, categoryValue);
        const entries = fs.readdirSync(categoryPath, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
            .map(entry => `/images/weapons-real/skins/${categoryValue}/${entry.name}`);

        for (const subcategory of entries.filter(entry => entry.isDirectory()).map(entry => entry.name)) {
            files.push(...getImagesForSubcategory(categoryValue, subcategory));
        }

        return files;
    } catch (err) {
        return [];
    }
}

function getImageForCategory(categoryValue) {
    const images = getImagesForCategory(categoryValue);
    if (images.length === 0) return null;
    return images[0];
}

const TITLE_TO_CATEGORY = {
    deserteagle: 'pistol',
    dualberettas: 'pistol',
    m4a4: 'rifle',
    sg553: 'rifle',
};

const CATEGORY_KEYWORDS = {
    knife: ['bayonet', 'bowieknife', 'butterflyknife', 'falchionknife', 'flipknife', 'gutknife', 'huntsmanknife', 'karambit', 'navajaknife', 'nomadknife', 'paracordknife', 'shadowdaggers', 'skeletonknife', 'stiletto', 'survivalknife', 'talonknife', 'ursusknife', 'classicknife', 'kukriknife'],
    gloves: ['bloodhoundgloves', 'brokenfanggloves', 'drivergloves', 'handwraps', 'hydragloves', 'motogloves', 'specialistgloves', 'sportgloves'],
    pistol: ['cz75auto', 'deserteagle', 'dualberettas', 'fiveseven', 'glock18', 'p2000', 'p250', 'r8revolver', 'tec9', 'usps'],
    rifle: ['ak47', 'aug', 'famas', 'galilar', 'm4a1s', 'm4a4', 'sg553'],
    sniper: ['awp', 'g3sg1', 'scar20', 'ssg08'],
    smg: ['mac10', 'mp5sd', 'mp7', 'mp9', 'p90', 'ppbizon', 'ump45'],
    shotgun: ['mag7', 'nova', 'sawedoff', 'xm1014'],
    machinegun: ['m249', 'negev'],
    agent: ['darryl', 'ricksaw', 'ava', 'operator', 'commando', 'agent'],
    case: ['case'],
    music_kit: ['musickit'],
    other: ['charm', 'sticker', 'graffiti', 'patch', 'capsule'],
};

function categoryForTitle(title) {
    const normalized = String(title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const categories = getCategories();

    const mapped = TITLE_TO_CATEGORY[normalized];
    if (mapped) {
        const found = categories.find((c) => c.value === mapped);
        if (found) return found;
    }

    for (const [categoryName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some((keyword) => normalized.includes(keyword))) {
            const found = categories.find((c) => c.value === categoryName);
            if (found) return found;
        }
    }

    for (const cat of categories) {
        const catNormalized = cat.value.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalized.includes(catNormalized) || catNormalized.includes(normalized)) {
            return cat;
        }
    }

    return null;
}

module.exports = { getCategories, getSubcategories, getImagesForCategory, getImagesForSubcategory, getImageForCategory, categoryForTitle };
