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
const BATCH_SIZE = parseInt(process.env.HUBSPOT_BATCH_SIZE) || 1000;
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

const getContactsFromList = async (listId, maxCount = Infinity) => {
  let allContacts = [];
  let hasMore = true;
  let offset = 0;
  let retryCount = 0;

  while (hasMore && retryCount < MAX_RETRIES && allContacts.length < maxCount) {
    try {
      const countToFetch = Math.min(RETRIEVAL_BATCH_SIZE, maxCount - allContacts.length);
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

      if (allContacts.length % 5000 === 0) {
        console.log(`Retrieved ${allContacts.length}/${maxCount} contacts from list ${listId}`);
      }
      
      if (allContacts.length >= maxCount) {
        allContacts = allContacts.slice(0, maxCount);
        break;
      }
    } catch (error) {
      console.error(`Error getting contacts from list ${listId}:`, error.message);
      retryCount++;
      
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * retryCount));
      } else {
        hasMore = false;
      }
    }
  }

  console.log(`Retrieved ${allContacts.length} contacts from list ${listId}`);
  return allContacts;
};

const createHubSpotList = async (name) => {
  try {
    const res = await axios.post(
      'https://api.hubapi.com/contacts/v1/lists',
      { name, dynamic: false },
      { headers: hubspotHeaders }
    );
    return res.data;
  } catch (error) {
    console.error('Error creating list:', error.message);
    throw error;
  }
};

const addContactsToList = async (listId, contacts) => {
  const chunks = chunkArray(contacts, BATCH_SIZE);
  
  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
        { vids: chunk },
        { headers: hubspotHeaders }
      );
      console.log(`➕ Added ${chunk.length} contacts to list ${listId}`);
    } catch (error) {
      console.error(`Failed to add batch to list ${listId}:`, error.message);
      
      // If batch fails, try splitting into smaller chunks
      if (chunk.length > 100) {
        const smallerChunks = chunkArray(chunk, 100);
        for (const smallChunk of smallerChunks) {
          try {
            await axios.post(
              `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
              { vids: smallChunk },
              { headers: hubspotHeaders }
            );
            console.log(`➕ Added ${smallChunk.length} contacts (retry)`);
          } catch (retryError) {
            console.error('Failed even with smaller batch:', retryError.message);
          }
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
};

const processSingleCampaign = async (config, daysFilter, modeFilter) => {
  const {
    brand, campaign, primaryListId, secondaryListId,
    count, domain, date, sendContactListId
  } = config;

  try {
    console.log(`\n📦 Processing campaign: ${campaign} (${brand}) - Target: ${count} contacts`);

    // First try to get exactly 'count' contacts from primary list
    let contacts = await getContactsFromList(primaryListId, count);

    // If we didn't get enough and there's a secondary list
    if (contacts.length < count && secondaryListId) {
      const needed = count - contacts.length;
      console.log(`🔁 Need ${needed} more contacts from secondary list`);
      const secondaryContacts = await getContactsFromList(secondaryListId, needed);
      contacts = contacts.concat(secondaryContacts);
    }

    // Final check if we got enough contacts
    const selectedContacts = contacts.slice(0, count);
    if (selectedContacts.length < count) {
      console.warn(`⚠️ Only got ${selectedContacts.length}/${count} contacts`);
    }

    const formattedDate = getFormattedDate(date);
    const listName = `${brand} - ${campaign} - ${domain} - ${formattedDate}`;
    
    // Create list and add contacts in parallel
    const [newList] = await Promise.all([
      createHubSpotList(listName),
      selectedContacts.length ? addContactsToList(sendContactListId, selectedContacts) : Promise.resolve()
    ]);

    if (selectedContacts.length) {
      await addContactsToList(newList.listId, selectedContacts);
      console.log(`✅ Added ${selectedContacts.length} contacts to new list`);
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

    return { 
      success: true, 
      listName, 
      listId: newList.listId,
      contactCount: selectedContacts.length,
      requestedCount: count
    };
  } catch (error) {
    console.error(`❌ Failed campaign "${campaign}":`, error.message);
    return { success: false, error: error.message };
  }
};

const processCampaignsInParallel = async (listConfigs, daysFilter, modeFilter) => {
  const results = [];
  const batches = chunkArray(listConfigs, CONCURRENCY_LIMIT);
  
  for (const batch of batches) {
    const batchPromises = batch.map(config => processSingleCampaign(config, daysFilter, modeFilter));
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
    
    if (batches.length > 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  return results;
};

router.post('/create-lists', async (req, res) => {
  const { daysFilter, modeFilter } = req.body;

  try {
    // Build query with proper date filtering
    let query = {};
    
    if (daysFilter && daysFilter !== 'all') {
      const filterDate = getFilteredDate(daysFilter);
      if (!filterDate) return res.status(400).json({ error: 'Invalid date filter' });
      query.date = filterDate;
    }

    // Mode filter
    if (modeFilter && modeFilter !== 'BAU') {
      query.campaign = { $regex: modeFilter === 're-engagement' ? /re-engagement/i : /re-activation/i };
    } else if (modeFilter === 'BAU') {
      query.$and = [
        { $or: [
          { campaign: { $not: { $regex: /re-engagement/i } } },
          { campaign: { $exists: false } }
        ]},
        { $or: [
          { campaign: { $not: { $regex: /re-activation/i } } },
          { campaign: { $exists: false } }
        ]}
      ];
    }

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
    
    const listConfigs = await Segmentation.find(query).lean();
    console.log('Matching campaigns:', listConfigs.map(c => ({
      campaign: c.campaign,
      date: c.date,
      brand: c.brand,
      count: c.count
    })));
    console.log('============================\n');

    if (!listConfigs.length) {
      return res.status(404).json({ 
        error: 'No campaigns match the selected filters',
        details: { daysFilter, modeFilter }
      });
    }

    // Respond immediately
    res.json({ 
      message: '🚀 List creation started in background',
      count: listConfigs.length,
      firstCampaign: listConfigs[0]?.campaign || 'None',
      totalContactsRequested: listConfigs.reduce((sum, c) => sum + c.count, 0)
    });

    // Process in background
    const results = await processCampaignsInParallel(listConfigs, daysFilter, modeFilter);

    // Generate summary
    const successes = results.filter(r => r.status === 'fulfilled' && r.value.success);
    const failures = results.filter(r => r.status === 'rejected' || !r.value.success);
    
    const totalRequested = listConfigs.reduce((sum, c) => sum + c.count, 0);
    const totalAdded = successes.reduce((sum, r) => sum + r.value.contactCount, 0);
    
    console.log('\n🎉 List creation summary:');
    console.log(`✅ ${successes.length} successful (${totalAdded}/${totalRequested} contacts)`);
    console.log(`❌ ${failures.length} failed`);
    
    if (successes.length) {
      console.log('\nCreated lists:');
      successes.forEach((result, i) => {
        const { value } = result;
        const countStatus = value.contactCount === value.requestedCount ? 
          `✅ Exact count` : `⚠️ Got ${value.contactCount}/${value.requestedCount}`;
        console.log(`${i+1}. ${value.listName}`);
        console.log(`   ${countStatus} | 🔗 https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/lists/${value.listId}`);
      });
    }

  } catch (error) {
    console.error('Error in list creation:', error);
    res.status(500).json({ 
      error: 'Failed to start list creation process',
      details: error.message
    });
  }
});

router.get('/created-lists', async (req, res) => {
  try {
    const lists = await CreatedList.find().sort({ createdDate: -1 }).lean();
    res.json(lists);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch created lists' });
  }
});

module.exports = router;