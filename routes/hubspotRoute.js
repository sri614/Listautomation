require('dotenv').config();
const express = require("express");
const router = express.Router();
const axios = require('axios');
const Segmentation = require('../models/segmentation');
const CreatedList = require('../models/list');

// Config
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const CONCURRENCY_LIMIT = parseInt(process.env.HUBSPOT_CONCURRENCY_LIMIT) || 3;
const RETRIEVAL_BATCH_SIZE = parseInt(process.env.HUBSPOT_RETRIEVAL_BATCH_SIZE) || 1000;
const MAX_RETRIES = parseInt(process.env.HUBSPOT_MAX_RETRIES) || 3;

const hubspotHeaders = {
  Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const getFormattedDate = (dateInput) => {
  const date = new Date(dateInput);
  return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
};

const getFilteredDate = (daysFilter) => {
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (daysFilter === 'today') {
    return today.toISOString().split('T')[0];
  } else if (daysFilter === 't+1') {
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(today.getUTCDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  } else if (daysFilter === 't+2') {
    const dayAfter = new Date(today);
    dayAfter.setUTCDate(today.getUTCDate() + 2);
    return dayAfter.toISOString().split('T')[0];
  }
  return null;
};

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const progressiveChunks = (arr, sizes = [300, 100, 50, 1]) => {
  const result = [];
  let index = 0;
  for (const size of sizes) {
    while (index < arr.length) {
      const chunk = arr.slice(index, index + size);
      if (!chunk.length) break;
      result.push(chunk);
      index += size;
    }
  }
  return result;
};

const getContactsFromList = async (listId, maxCount = Infinity) => {
  let allContacts = [];
  let hasMore = true;
  let offset = 0;
  let retryCount = 0;

  while (hasMore && retryCount < MAX_RETRIES && allContacts.length < maxCount) {
    try {
      const countToFetch = Math.min(RETRIEVAL_BATCH_SIZE, maxCount - allContacts.length);
      console.log(`🔍 Fetching contacts from list: ${listId} | So far: ${allContacts.length}`);
      const res = await axios.get(
        `https://api.hubapi.com/contacts/v1/lists/${listId}/contacts/all`,
        {
          headers: hubspotHeaders,
          params: {
            count: countToFetch,
            vidOffset: offset
          }
        }
      );

      const contacts = res.data.contacts || [];
      allContacts.push(...contacts.map(c => c.vid));
      hasMore = res.data['has-more'] && allContacts.length < maxCount;
      offset = res.data['vid-offset'];
      retryCount = 0;

      if (allContacts.length >= maxCount) {
        allContacts = allContacts.slice(0, maxCount);
        break;
      }
    } catch (error) {
      console.error(`⚠️ Error on attempt ${retryCount} for list ${listId}:`, error.message);
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * retryCount));
      } else {
        hasMore = false;
      }
    }
  }

  return allContacts;
};

const createHubSpotList = async (name) => {
  console.log(`📝 Creating new HubSpot list: ${name}`);
  const res = await axios.post(
    'https://api.hubapi.com/contacts/v1/lists',
    { name, dynamic: false },
    { headers: hubspotHeaders }
  );
  return res.data;
};

const addContactsToList = async (listId, contacts) => {
  console.log(`📤 Adding ${contacts.length} contacts to list ${listId}`);
  const chunks = progressiveChunks(contacts);

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
        { vids: chunk },
        { headers: hubspotHeaders }
      );
      console.log(`   → Chunk of ${chunk.length} added`);
    } catch (error) {
      console.error(`Failed to add contacts to list ${listId}:`, error.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
};

// ✅ Updated: Batch update recent_marketing_email_sent_date
const updateRecentDate = async (contactIds, dateValue) => {
  const epochMidnight = new Date(dateValue);
  epochMidnight.setUTCHours(0, 0, 0, 0);
  const epochTime = epochMidnight.getTime();
  console.log(`🕓 Batch updating 'recent_marketing_email_sent_date' for ${contactIds.length} contacts to ${dateValue} (${epochTime})`);

  const chunks = chunkArray(contactIds, 100); // HubSpot limit

  for (const chunk of chunks) {
    const payload = {
      inputs: chunk.map(vid => ({
        id: vid.toString(),
        properties: {
          recent_marketing_email_sent_date: epochTime
        }
      }))
    };

    try {
      await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts/batch/update',
        payload,
        { headers: hubspotHeaders }
      );
      // console.log(`✅ Successfully updated ${chunk.length} contacts`);
    } catch (err) {
      console.error(`❌ Failed batch update for chunk:`, err.response?.data || err.message);
    }

    await new Promise(r => setTimeout(r, 300));
  }
};

const processSingleCampaign = async (config, daysFilter, modeFilter) => {
  const { brand, campaign, primaryListId, secondaryListId, count, domain, date, sendContactListId } = config;

  console.log(`🚀 Processing campaign: ${campaign} | Brand: ${brand} | Domain: ${domain}`);

  let contacts = await getContactsFromList(primaryListId, count);
  if (contacts.length < count && secondaryListId) {
    const needed = count - contacts.length;
    const secondaryContacts = await getContactsFromList(secondaryListId, needed);
    contacts = contacts.concat(secondaryContacts);
  }

  const selectedContacts = contacts.slice(0, count);
  console.log(`🔢 Selected ${selectedContacts.length} contacts out of requested ${count}`);

  const formattedDate = getFormattedDate(date);
  const listName = `${brand} - ${campaign} - ${domain} - ${formattedDate}`;

  const [newList] = await Promise.all([
    createHubSpotList(listName),
    selectedContacts.length ? addContactsToList(sendContactListId, selectedContacts) : Promise.resolve()
  ]);

  if (selectedContacts.length) {
    // console.log(newList)
    await addContactsToList(newList.listId, selectedContacts);
    await updateRecentDate(selectedContacts, date);
  }

  await CreatedList.create({
    name: listName,
    listId: newList.listId,
    createdDate: new Date(),
    filterCriteria: { days: daysFilter, mode: modeFilter },
    campaignDetails: { brand, campaign, date },
    contactCount: selectedContacts.length,
    requestedCount: count
  });

  console.log(`✅ Saved new list record: ${listName} (${selectedContacts.length} contacts)`);

  return {
    success: true,
    listName,
    listId: newList.listId,
    contactCount: selectedContacts.length,
    requestedCount: count
  };
};

const processCampaignsInParallel = async (listConfigs, daysFilter, modeFilter) => {
  const results = [];
  const batches = chunkArray(listConfigs, CONCURRENCY_LIMIT);

  console.log(`📦 Processing ${listConfigs.length} campaigns in batches of ${CONCURRENCY_LIMIT}`);

  for (const batch of batches) {
    console.log(`   → Processing batch of ${batch.length} campaigns...`);
    const batchPromises = batch.map(config => processSingleCampaign(config, daysFilter, modeFilter));
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
};

router.post('/create-lists', async (req, res) => {
  const { daysFilter, modeFilter } = req.body;
  console.log(`📨 Received request to create lists | Filter: ${daysFilter}, Mode: ${modeFilter}`);
  let query = {};

  if (daysFilter && daysFilter !== 'all') {
    const filterDate = getFilteredDate(daysFilter);
    if (!filterDate) return res.status(400).json({ error: 'Invalid date filter' });
    query.date = filterDate;
  }

  if (modeFilter && modeFilter !== 'BAU') {
    query.campaign = { $regex: modeFilter === 're-engagement' ? /re-engagement/i : /re-activation/i };
  } else if (modeFilter === 'BAU') {
    query.$and = [
      { $or: [{ campaign: { $not: { $regex: /re-engagement/i } } }, { campaign: { $exists: false } }] },
      { $or: [{ campaign: { $not: { $regex: /re-activation/i } } }, { campaign: { $exists: false } }] }
    ];
  }

  const listConfigs = await Segmentation.find(query).lean();
  if (!listConfigs.length) {
    return res.status(404).json({ error: 'No campaigns match the selected filters' });
  }

  res.json({
    message: '🚀 List creation started in background',
    count: listConfigs.length,
    firstCampaign: listConfigs[0]?.campaign || 'None',
    totalContactsRequested: listConfigs.reduce((sum, c) => sum + c.count, 0)
  });

  console.log(`⏳ Starting background list creation for ${listConfigs.length} campaigns...`);

  const results = await processCampaignsInParallel(listConfigs, daysFilter, modeFilter);
  const successes = results.filter(r => r.status === 'fulfilled' && r.value.success);
  const failures = results.filter(r => r.status === 'rejected' || !r.value.success);

  console.log(`✅ ${successes.length} campaigns processed successfully`);
  console.log(`❌ ${failures.length} campaigns failed`);
});

router.get('/created-lists', async (req, res) => {
  try {
   
const now = new Date();
const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const endOfDay = new Date(startOfDay);
endOfDay.setUTCDate(startOfDay.getUTCDate() + 1);

const lists = await CreatedList.find({
  //fetch current date list only
  // createdDate: {
  //   $gte: startOfDay,
  //   $lt: endOfDay
  // }
}).sort({ createdDate: -1 }).lean();
    res.json(lists);
  } catch (error) {
    console.error('❌ Failed to fetch created lists:', error.message);
    res.status(500).json({ error: 'Failed to fetch created lists' });
  }
});

module.exports = router;
