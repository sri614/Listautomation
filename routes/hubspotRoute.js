require('dotenv').config();
const express = require("express");
const router = express.Router();
const axios = require('axios');
const Segmentation = require('../models/segmentation');
const CreatedList = require('../models/list');

// Config
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;

const hubspotHeaders = {
  Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const getFormattedDate = (dateInput) => {
  const date = new Date(dateInput);
  return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
};

// Improved date filtering function with UTC handling
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

const getContactsFromList = async (listId) => {
  let allContacts = [];
  let hasMore = true;
  let offset = 0;

  while (hasMore) {
    const res = await axios.get(
      `https://api.hubapi.com/contacts/v1/lists/${listId}/contacts/all`,
      {
        headers: hubspotHeaders,
        params: { count: 100, vidOffset: offset }
      }
    );
    const contacts = res.data.contacts || [];
    allContacts.push(...contacts.map(c => c.vid));
    hasMore = res.data['has-more'];
    offset = res.data['vid-offset'];

    if (allContacts.length >= 10000) break;
  }

  return allContacts;
};

const createHubSpotList = async (name) => {
  const res = await axios.post(
    'https://api.hubapi.com/contacts/v1/lists',
    { name, dynamic: false },
    { headers: hubspotHeaders }
  );
  return res.data;
};

const addContactsToList = async (listId, contacts) => {
  const batchSizes = [100, 50, 10, 1];

  for (let size of batchSizes) {
    const chunks = chunkArray(contacts, size);
    for (const chunk of chunks) {
      try {
        await axios.post(
          `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
          { vids: chunk },
          { headers: hubspotHeaders }
        );
        console.log(`➕ Added ${chunk.length} contacts to list ID ${listId}`);
        await new Promise(r => setTimeout(r, 200)); // rate limit buffer
      } catch (err) {
        console.warn(`⚠️ Failed batch (${chunk.length}):`, err.response?.data || err.message);
      }
    }
  }
};

router.post('/create-lists', async (req, res) => {
  const LIST_CREATION_INTERVAL = 60 * 1000; // 1 minute
  const { daysFilter, modeFilter } = req.body;

  try {
    // Build query with proper date filtering
    let query = {};
    
    // Date filter
    if (daysFilter && daysFilter !== 'all') {
      const filterDate = getFilteredDate(daysFilter);
      if (!filterDate) {
        return res.status(400).json({ error: 'Invalid date filter' });
      }
      query.date = filterDate;
    }

    // Mode filter
    if (modeFilter && modeFilter !== 'BAU') {
      if (modeFilter === 're-engagement') {
        query.campaign = { $regex: /re-engagement/i };
      } else if (modeFilter === 're-activation') {
        query.campaign = { $regex: /re-activation/i };
      }
    } else if (modeFilter === 'BAU') {
      query.$and = [
        { 
          $or: [
            { campaign: { $not: { $regex: /re-engagement/i } } },
            { campaign: { $exists: false } }
          ]
        },
        { 
          $or: [
            { campaign: { $not: { $regex: /re-activation/i } } },
            { campaign: { $exists: false } }
          ]
        }
      ];
    }

    // Enhanced debug logging
    console.log('\n======== DEBUG INFO ========');
    console.log('System date:', new Date().toISOString());
    console.log('Today (UTC):', new Date(Date.UTC(
      new Date().getFullYear(), 
      new Date().getMonth(), 
      new Date().getDate()
    )).toISOString().split('T')[0]);
    console.log('Filter criteria:', { daysFilter, modeFilter });
    console.log('Computed filter date:', getFilteredDate(daysFilter));
    console.log('MongoDB query:', JSON.stringify(query, null, 2));
    
    // Temporary test query
    const testDate = '2025-06-14';
    const testResults = await Segmentation.find({ date: testDate }).lean();
    console.log('TEST: Manual query for 2025-06-14:', testResults.map(c => ({
      campaign: c.campaign,
      date: c.date,
      brand: c.brand
    })));
    console.log('============================\n');

    const listConfigs = await Segmentation.find(query).lean();
    console.log('Matching campaigns:', listConfigs.map(c => ({
      campaign: c.campaign,
      date: c.date,
      brand: c.brand
    })));

    if (!listConfigs.length) {
      return res.status(404).json({ 
        error: 'No campaigns match the selected filters',
        details: {
          daysFilter,
          modeFilter,
          suggestion: 'Please check your filter criteria and campaign dates',
          debugInfo: {
            systemDate: new Date().toISOString(),
            computedFilterDate: getFilteredDate(daysFilter),
            testQueryResults: testResults.length
          }
        }
      });
    }

    // Respond immediately to the client
    res.json({ 
      message: '📤 List creation started in background. Watch logs for progress.',
      filter: { daysFilter, modeFilter },
      count: listConfigs.length,
      firstCampaign: listConfigs[0]?.campaign || 'None'
    });

    // Background async task
    (async () => {
      const createdListsSummary = [];

      for (let i = 0; i < listConfigs.length; i++) {
        const config = listConfigs[i];
        const {
          brand, campaign, primaryListId, secondaryListId,
          count, domain, date, sendContactListId
        } = config;

        try {
          console.log(`\n📦 Processing campaign: ${campaign} (${brand})`);

          let contacts = await getContactsFromList(primaryListId);

          if (contacts.length < count && secondaryListId) {
            const secondaryContacts = await getContactsFromList(secondaryListId);
            const needed = count - contacts.length;
            contacts = contacts.concat(secondaryContacts.slice(0, needed));
            console.log(`🔄 Filled ${needed} contacts from secondary list`);
          }

          const selectedContacts = contacts.slice(0, count);

          const formattedDate = getFormattedDate(date);
          const listName = `${brand} - ${campaign} - ${domain} - ${formattedDate}`;
          const newList = await createHubSpotList(listName);

          if (selectedContacts.length) {
            await addContactsToList(newList.listId, selectedContacts);
            console.log(`👥 Total contacts added: ${selectedContacts.length}`);

            if (sendContactListId) {
              await addContactsToList(sendContactListId, selectedContacts);
              console.log(`📨 Also added to sendContactList ID: ${sendContactListId}`);
            }
          } else {
            console.warn(`⚠️ Created empty list for ${campaign}: no contacts to add.`);
          }

          console.log(`✅ Created list: ${listName}`);
          console.log(`🔗 https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/lists/${newList.listId}`);

          // Save to MongoDB
          await CreatedList.create({
            name: listName,
            listId: newList.listId,
            createdDate: new Date(),
            filterCriteria: {
              days: daysFilter,
              mode: modeFilter
            },
            campaignDetails: {
              brand,
              campaign,
              date
            }
          });

          createdListsSummary.push({
            name: listName,
            id: newList.listId,
            campaign,
            brand,
            contactCount: selectedContacts.length
          });

        } catch (err) {
          console.error(`❌ Failed campaign "${config.campaign}":`, err.response?.data || err.message);
        }

        if (i < listConfigs.length - 1) {
          console.log(`⏳ Waiting ${LIST_CREATION_INTERVAL/1000}s before next list...`);
          await new Promise(resolve => setTimeout(resolve, LIST_CREATION_INTERVAL));
        }
      }

      console.log(`🎉 All lists processed with filters: ${modeFilter}, ${daysFilter}`);
      console.log(`📋 Created Lists Summary:`);
      createdListsSummary.forEach(({ name, id, campaign, brand, contactCount }) => {
        console.log(`🆕 ${brand} - ${campaign} → ${name} (${contactCount} contacts) → ID: ${id}`);
      });
    })();

  } catch (error) {
    console.error('Error in list creation:', error);
    res.status(500).json({ 
      error: 'Failed to start list creation process',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// New endpoint to get created lists
router.get('/created-lists', async (req, res) => {
  try {
    const lists = await CreatedList.find().sort({ createdDate: -1 }).lean();
    res.json(lists);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch created lists' });
  }
});

module.exports = router;